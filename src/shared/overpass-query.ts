/**
 * Shared Overpass endpoint selection with health-aware failover.
 *
 * The previous pool was three hostnames of ONE deployment
 * (`overpass-api.de`, `lz4.`, `z.`), so every "retry on the next server"
 * hit the same infrastructure: when that deployment went down the whole
 * pipeline lost OSM, twice in one day, and rebuilt a 152m tower as an 8m
 * solar-bbox guess. Probed live 2026-08-16 with the main family down:
 *
 *   overpass-api.de          fetch failed
 *   lz4.overpass-api.de      fetch failed
 *   z.overpass-api.de        fetch failed
 *   overpass.kumi.systems    timeout (25s)
 *   overpass.private.coffee  OK  (6.9s)
 *   overpass.osm.ch          OK but SWITZERLAND-ONLY — see the pool comment
 *
 * The pool now spans independent operators, and a server that just failed
 * is deprioritised for `FAILURE_COOLDOWN_MS` so the retry loop moves to
 * working infrastructure instead of re-hitting a dead host.
 */

/**
 * GLOBAL-COVERAGE instances only.
 *
 * DO NOT add a regional instance here. Probed 2026-08-16:
 * `overpass.osm.ch` answers a New York query with **HTTP 200 and
 * `elements: []`** while answering the same query for Zurich with real data —
 * it carries a Switzerland-only database. An empty 200 is indistinguishable
 * from "no building is mapped here", so a regional mirror does not degrade
 * the pipeline, it silently CORRUPTS it: the footprint falls back to a solar
 * bbox and a 152m tower is rebuilt as an 8m guess, with every downstream gate
 * reporting a confident wrong answer. An outage is recoverable; a plausible
 * wrong answer is not. Same reasoning excludes `overpass.osm.jp`.
 */
const OVERPASS_SERVERS = [
  // Main deployment (fastest when healthy) …
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  // … then independent operators that carry the FULL planet.
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** How long a failing server stays deprioritised. */
const FAILURE_COOLDOWN_MS = 5 * 60_000;

/** url → epoch ms of its most recent recorded failure. */
const lastFailure = new Map<string, number>();

// Single-threaded round-robin counter — safe for async but not for worker threads
let nextServerIdx = 0;

/**
 * Pick the next Overpass server, skipping any that failed within the
 * cooldown. Falls back to plain round-robin when every server is cooling
 * down (better to retry a probably-dead host than to give up outright).
 */
export function pickOverpassUrl(): string {
  const now = Date.now();
  for (let i = 0; i < OVERPASS_SERVERS.length; i++) {
    const url = OVERPASS_SERVERS[(nextServerIdx + i) % OVERPASS_SERVERS.length];
    const failedAt = lastFailure.get(url);
    if (failedAt === undefined || now - failedAt > FAILURE_COOLDOWN_MS) {
      nextServerIdx = (nextServerIdx + i + 1) % OVERPASS_SERVERS.length;
      return url;
    }
  }
  const url = OVERPASS_SERVERS[nextServerIdx];
  nextServerIdx = (nextServerIdx + 1) % OVERPASS_SERVERS.length;
  return url;
}

/**
 * Record that `url` failed (transport error, 429, 5xx). Callers should
 * invoke this in their retry loop so the next attempt lands elsewhere.
 */
export function reportOverpassFailure(url: string): void {
  lastFailure.set(url, Date.now());
}

/** Record that `url` served a good response — clears any cooldown. */
export function reportOverpassSuccess(url: string): void {
  lastFailure.delete(url);
}

/** Test seam: forget all recorded health state. */
export function resetOverpassHealth(): void {
  lastFailure.clear();
  nextServerIdx = 0;
}

/** The configured pool, for diagnostics and tests. */
export function overpassServers(): readonly string[] {
  return OVERPASS_SERVERS;
}
