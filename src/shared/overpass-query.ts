/**
 * Shared Overpass API round-robin server selection.
 * Deduplicates identical nextServerIdx + OVERPASS_SERVERS pattern across
 * osm.ts, scene-enrichment.ts, and osm-infrastructure.ts.
 */

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];
let nextServerIdx = 0;

/** Pick next Overpass server in round-robin order */
export function pickOverpassUrl(): string {
  const url = OVERPASS_SERVERS[nextServerIdx % OVERPASS_SERVERS.length];
  nextServerIdx = (nextServerIdx + 1) % OVERPASS_SERVERS.length;
  return url;
}
