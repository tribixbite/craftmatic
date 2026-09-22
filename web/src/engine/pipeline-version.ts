/**
 * Pack PROVENANCE: which build of the export pipeline produced a Bedrock pack,
 * and which source model it was built from.
 *
 * Why this exists: once a pack is on a phone there was no way to tell which
 * toolchain built it. A device round was lost to a stale pack folder that the
 * game resolved while the new one sat beside it — the only tell was reading
 * `manifest.json` by hand. Every pack now carries the stamp where a person
 * looks first (the pack NAME in Minecraft's add-on list) and in full where a
 * tool looks (`craftmatic-provenance.json`, also spread into
 * `craftmatic-diagnostics.json`).
 *
 * The stamp is computed OUTSIDE this module. It needs the working tree and git,
 * which exist at build time (`scripts/pipeline-stamp.ts`, run by
 * `web/vite.config.ts` and by the CLI exporters) but never in the browser —
 * the web app builds packs in a Worker with no filesystem. So the build
 * injects the finished stamp as the `__PIPELINE_STAMP__` constant (Vite
 * `define`) and this module only READS it. Anything that runs the engine
 * without that constant (vitest, an un-built import) gets an honest
 * `unstamped` value, never a fabricated commit.
 *
 * Scheme, in one paragraph (the comparison lives in the report / guide):
 * the pipeline's identity is a sha256/12 CONTENT HASH over the transitive
 * import closure of the export entry points, with line endings normalised —
 * identical on every machine and in a shallow CI clone, and it covers
 * uncommitted edits by construction. Git supplies the human-readable half:
 * the short sha and date of the last commit that touched that closure. When
 * the closure differs from that commit the stamp says `+dirty` and names the
 * files. The Bedrock manifest `version` stays a monotonic build instant, not
 * the pipeline version: Minecraft only replaces an installed pack when the
 * version rises, and a re-export at another quality must replace it even when
 * the pipeline did not change.
 */

/** Injected by `web/vite.config.ts` (`define`); absent under vitest and bare imports. */
declare const __PIPELINE_STAMP__: unknown;

/** Identity of the export pipeline that built a pack. */
export interface PipelineStamp {
  /** `stamped` when computed from a working tree; `unstamped` when nothing could be. */
  kind: 'stamped' | 'unstamped';
  /** sha256/12 over the pipeline module closure (LF-normalised), or null when unstamped. */
  hash: string | null;
  /** Number of source files in the closure. */
  files: number;
  /** Short sha (8 hex) of the last commit touching the closure; null without git. */
  commit: string | null;
  /** Commit date (`YYYY-MM-DD`) of `commit`; null without git. */
  date: string | null;
  /** HEAD short sha at stamp time; null without git. */
  head: string | null;
  /** HEAD commit date (`YYYY-MM-DD`); null without git. */
  headDate: string | null;
  /** True when any closure file differs from `commit` (modified, staged or untracked). */
  dirty: boolean;
  /** Repo-relative closure files that are dirty (empty when clean). */
  dirtyFiles: string[];
  /** True when ANY tracked file in the repo is modified — informational; the name uses `dirty`. */
  treeDirty: boolean;
  /** True in a shallow clone (CI): `commit` then equals HEAD rather than the true last touch. */
  shallow: boolean;
  /** ISO-8601 instant at which the stamp was computed (the web build, or the CLI run). */
  computedAt: string;
  /** Why the stamp is `unstamped`, when it is. */
  reason?: string;
}

/** Which model file a pack was built from. */
export interface SourceProvenance {
  /** File name as the user saw it (`10303 Loop Coaster.io`). */
  file: string;
  /** sha256/12 of the file bytes — the model index's convention — or null when unavailable. */
  hash: string | null;
  /** Where the bytes came from. */
  origin: 'index' | 'upload' | 'cli' | 'unknown';
  /** Index path (`IO/10303 Loop Coaster.io`) or CLI path, when there is one. */
  path?: string;
  /** Set number when known (`10303-1`). */
  setNum?: string;
}

/**
 * The LDraw → world frame this pipeline places everything in, recorded in the
 * provenance so a pack can be told apart from one built before 2026-09-22.
 * Until then the block grid, the building shell and every 3D export negated
 * Y ALONE (det −1): they were the model's MIRROR IMAGE, and a hinge, a printed
 * sign or a coaster's turn came out on the wrong side. `x180` is the half turn
 * about X: LDraw (x, y, z) → world (x, −y, −z), the model's −Z front to +Z
 * (south). A pack WITHOUT this field was built by the mirrored pipeline; its
 * structure cannot be overlaid on a new export of the same model, and the
 * export notes say so (`bedrock-export-notes.ts`).
 */
export const LDRAW_WORLD_FRAME = 'x180' as const;

/** The full record written into the pack. */
export interface PackProvenance {
  generator: 'craftmatic';
  /** ISO-8601 instant the pack was built. */
  builtAt: string;
  /** The LDraw → world frame (`LDRAW_WORLD_FRAME`); absent in packs from the mirrored pipeline (before 2026-09-22). */
  frame: typeof LDRAW_WORLD_FRAME;
  /** Bedrock manifest version, and its meaning. */
  packVersion: { value: [number, number, number]; encodes: string };
  /** The stamp as shown in the pack name. */
  display: string;
  pipeline: PipelineStamp;
  source: SourceProvenance | null;
}

const UNSTAMPED_REASON = '__PIPELINE_STAMP__ was not injected: engine imported outside a Vite build (vitest, bare import) and no stamp was supplied';

/** A stamp that admits nothing is known. */
export function unstampedPipeline(reason = UNSTAMPED_REASON, computedAt = new Date().toISOString()): PipelineStamp {
  return { kind: 'unstamped', hash: null, files: 0, commit: null, date: null, head: null, headDate: null, dirty: false, dirtyFiles: [], treeDirty: false, shallow: false, computedAt, reason };
}

const HEX12 = /^[0-9a-f]{12}$/;
const SHORT_SHA = /^[0-9a-f]{7,40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an injected value before trusting it. The constant is produced by
 * our own build script, but a hand-edited define or an old bundle must
 * degrade to `unstamped` rather than crash every export.
 */
export function coercePipelineStamp(value: unknown): PipelineStamp {
  if (!value || typeof value !== 'object') return unstampedPipeline();
  const v = value as Record<string, unknown>;
  if (v['kind'] === 'unstamped') return unstampedPipeline(typeof v['reason'] === 'string' ? v['reason'] : 'build injected an unstamped value', typeof v['computedAt'] === 'string' ? v['computedAt'] : new Date().toISOString());
  const hash = typeof v['hash'] === 'string' && HEX12.test(v['hash']) ? v['hash'] : null;
  if (!hash) return unstampedPipeline('injected stamp has no valid sha256/12 hash');
  const sha = (x: unknown): string | null => typeof x === 'string' && SHORT_SHA.test(x) ? x : null;
  const date = (x: unknown): string | null => typeof x === 'string' && ISO_DATE.test(x) ? x : null;
  const dirtyFiles = Array.isArray(v['dirtyFiles']) ? v['dirtyFiles'].filter((f): f is string => typeof f === 'string') : [];
  return {
    kind: 'stamped',
    hash,
    files: typeof v['files'] === 'number' && Number.isInteger(v['files']) && v['files'] >= 0 ? v['files'] : 0,
    commit: sha(v['commit']),
    date: date(v['date']),
    head: sha(v['head']),
    headDate: date(v['headDate']),
    dirty: v['dirty'] === true || dirtyFiles.length > 0,
    dirtyFiles,
    treeDirty: v['treeDirty'] === true,
    shallow: v['shallow'] === true,
    computedAt: typeof v['computedAt'] === 'string' ? v['computedAt'] : new Date().toISOString(),
  };
}

/** The stamp the running build was injected with, or `unstamped`. */
export function currentPipelineStamp(): PipelineStamp {
  return coercePipelineStamp(typeof __PIPELINE_STAMP__ === 'undefined' ? undefined : __PIPELINE_STAMP__);
}

/**
 * The short stamp shown in the PACK NAME, e.g. `2026-09-21 1b74f4ee`.
 *
 * Designed for one reading task: a list of pack names, scanned at a glance,
 * to find the pack from an OLDER pipeline. A date orders instantly, so it
 * comes first; the sha follows so the pack maps to `git log`. The date is the
 * date the pipeline code LAST CHANGED — the commit date when the tree is
 * clean, the stamp's own date when it is dirty (the last change is the
 * uncommitted edit itself), and `+dirty` says so in the name because the whole
 * point is trusting what is on screen. Without git the content hash stands in;
 * with nothing at all the name says `unstamped` rather than nothing.
 */
export function pipelineStampText(stamp: PipelineStamp): string {
  if (stamp.kind === 'unstamped' || !stamp.hash) return 'unstamped';
  if (!stamp.commit || !stamp.date) return `hash ${stamp.hash}`;
  if (!stamp.dirty) return `${stamp.date} ${stamp.commit}`;
  return `${stamp.computedAt.slice(0, 10)} ${stamp.commit}+dirty`;
}

/**
 * Manifest `header.name`: `<label> — <role> (<stamp>)`.
 *
 * The stamp goes LAST so the model name survives Minecraft's truncation, and
 * the role keeps the behavior and resource packs distinguishable exactly as
 * before (`Playable` vs `Playable Resources`). This composes the DISPLAY name
 * only — never feed it to `packIdentity()`: the manifest UUIDs derive from the
 * raw stem/label, and a stamp in that derivation would turn every pipeline
 * build into a NEW pack instead of an upgrade of the installed one.
 */
export function packDisplayName(label: string, role: string | null, stamp: PipelineStamp): string {
  const base = role ? `${label} — ${role}` : label;
  return `${base} (${pipelineStampText(stamp)})`;
}

/**
 * One sentence for the manifest `description` (shown under the name in the
 * pack list): the source file + its hash and the pipeline identity.
 */
export function provenanceSentence(stamp: PipelineStamp, source: SourceProvenance | null): string {
  const pipeline = stamp.kind === 'stamped' && stamp.hash ? `pipeline ${stamp.hash}${stamp.commit ? ` @ ${stamp.commit}${stamp.dirty ? '+dirty' : ''}` : ''}` : 'pipeline unstamped';
  const src = source ? `from ${source.file}${source.hash ? ` (${source.hash})` : ' (unhashed)'}` : 'from an unrecorded source';
  return `Built ${src} by ${pipeline}.`;
}

// ── Bedrock manifest version ──────────────────────────────────────────────────

/**
 * A human-readable, monotonic manifest version from a build instant (UTC):
 * `[YYMM, DDHH, MMSS]`, so `2609.2114.3059` reads as 2026-09-21 14:30:59Z in
 * the game's own "Technical details" dialog without decoding anything.
 *
 * Semantics kept from the previous `exportVersion` (seconds since 2026-01-01
 * in base 32768): every component is a non-negative integer, well under
 * 32767, and tuple order is chronological to the second, so a later export of
 * the same set (same UUIDs) always ranks NEWER and Minecraft replaces the
 * installed pack. The transition is monotonic too: the previous encoding's
 * first component was 2 (3 after 2060); this one starts at 2601. Two exports
 * within one second tie, as before. The version is the BUILD instant on
 * purpose — see the module comment: a version derived from the pipeline would
 * not rise for a re-export at another scale or quality, and the game would
 * then refuse to replace the old pack, which is the stale-folder failure this
 * module exists to prevent.
 */
export function packVersionAt(now = Date.now()): [number, number, number] {
  if (!Number.isFinite(now)) throw new RangeError('Pack version timestamp must be finite.');
  const d = new Date(now);
  const year = d.getUTCFullYear();
  if (year < 2026 || year > 2099) throw new RangeError(`Pack version year ${year} is outside the supported 2026-2099 range.`);
  return [
    (year - 2000) * 100 + (d.getUTCMonth() + 1),
    d.getUTCDate() * 100 + d.getUTCHours(),
    d.getUTCMinutes() * 100 + d.getUTCSeconds(),
  ];
}

/** Human reading of a `packVersionAt` triple, e.g. `2026-09-21T14:30:59Z`. */
export function describePackVersion(version: readonly [number, number, number]): string {
  const [a, b, c] = version;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `20${p2(Math.floor(a / 100))}-${p2(a % 100)}-${p2(Math.floor(b / 100))}T${p2(b % 100)}:${p2(Math.floor(c / 100))}:${p2(c % 100)}Z`;
}

/** Assemble the record written into the pack. */
export function packProvenance(args: { stamp: PipelineStamp; source: SourceProvenance | null; version: [number, number, number]; builtAt?: string }): PackProvenance {
  const builtAt = args.builtAt ?? new Date().toISOString();
  return {
    generator: 'craftmatic',
    builtAt,
    frame: LDRAW_WORLD_FRAME,
    packVersion: { value: args.version, encodes: describePackVersion(args.version) },
    display: pipelineStampText(args.stamp),
    pipeline: args.stamp,
    source: args.source,
  };
}

// ── SHA-256 (pure TypeScript) ─────────────────────────────────────────────────
//
// The source hash must match the model index's sha256/12 on every surface. The
// browser's `crypto.subtle` is absent on an insecure origin — which is exactly
// how the phone loads the dev server (`http://10.0.0.211:4000`) — and the Worker
// and CLI paths should not depend on it either. FIPS 180-4, no dependencies.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of `bytes` as lowercase hex (64 chars). */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const bitLen = bytes.length * 8;
  // Padding: 0x80, zeros to 56 mod 64, then the 64-bit big-endian bit length.
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
}

/** sha256/12 of raw bytes — the identity the model index stamps per file. */
export function sourceHash12(bytes: Uint8Array | ArrayBuffer): string {
  return sha256Hex(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice(0, 12);
}
