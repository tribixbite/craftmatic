/**
 * Pure parts of `release.ts finalize | verify | status` (D-08b, BIZ-51 / BIZ-56): comparing a rebuild with the
 * prepared release, the tag rules, the ledger entry a finalized release appends, and the status table. Nothing here
 * reads a file, runs a process or creates a tag: `scripts/release.ts` supplies the facts.
 */
import type { IdentityLedgerEntry, ProductRecord, ReleasedVersion, SemVer } from './types.js';
import { formatSemVer } from './semver.js';
import type { RawFile } from './prepare.js';

/** One artifact of a release: file (`dist/...`), sha256 and size. */
export type ArtifactSum = ReleasedVersion['artifacts'][number];

/** The tag a release is made from: `<product>-v<semver>`. The user creates it; this code never does. */
export const releaseTag = (productId: string, version: SemVer): string => `${productId}-v${formatSemVer(version)}`;

/**
 * Every way a rebuild differs from the prepared artifacts (empty = identical). One byte of difference changes the
 * sha256, so equality of the hashes IS byte identity; sizes are reported too because they say how far apart two
 * builds are.
 */
export function compareArtifacts(prepared: readonly ArtifactSum[], rebuilt: readonly ArtifactSum[]): string[] {
  const out: string[] = [];
  const got = new Map(rebuilt.map(a => [a.file, a]));
  const want = new Set(prepared.map(a => a.file));
  for (const a of prepared) {
    const b = got.get(a.file);
    if (!b) out.push(`missing from the rebuild: ${a.file} (prepared ${a.sha256})`);
    else if (b.sha256 !== a.sha256) out.push(`${a.file} differs: prepared sha256 ${a.sha256} (${a.bytes} bytes), rebuild ${b.sha256} (${b.bytes} bytes)`);
  }
  for (const b of rebuilt) if (!want.has(b.file)) out.push(`not in the prepared release: ${b.file} (rebuild ${b.sha256})`);
  return out;
}

/**
 * Why a tag cannot be finalized: it does not exist, or it points at another commit than the one the release was
 * prepared from (the build clock is that commit's time, so another commit rebuilds other bytes). `tagCommit` is null
 * when the tag does not exist.
 */
export function tagProblems(tag: string, tagCommit: string | null, preparedCommit: string): string[] {
  if (tagCommit === null) return [`tag ${tag} does not exist; you create it (the command is in APPROVAL.md), this script never does`];
  if (tagCommit !== preparedCommit) return [`tag ${tag} points at ${tagCommit} but the release was prepared from ${preparedCommit}: tag that commit`];
  return [];
}

/** The identifiers a pack defines (what the ledger freezes). */
export interface PackIds { entityIds: string[]; blockIds: string[]; itemIds: string[] }

const KINDS: ReadonlyArray<[keyof PackIds, string, string]> = [
  ['entityIds', 'entities', 'minecraft:entity'], ['blockIds', 'blocks', 'minecraft:block'], ['itemIds', 'items', 'minecraft:item'],
];

/** Entity, block and item identifiers of the BEHAVIOUR pack's definition files, sorted. */
export function packIds(files: readonly RawFile[]): PackIds {
  const ids: PackIds = { entityIds: [], blockIds: [], itemIds: [] };
  for (const f of files) {
    const m = /^[^/]+_BP\/(entities|blocks|items)\/.*\.json$/.exec(f.name);
    if (!m) continue;
    const [key, , root] = KINDS.find(k => k[1] === m[1])!;
    const id = (JSON.parse(new TextDecoder().decode(f.data)) as Record<string, { description?: { identifier?: string } } | undefined>)[root]?.description?.identifier;
    if (typeof id === 'string') ids[key].push(id);
  }
  for (const k of Object.keys(ids) as Array<keyof PackIds>) ids[k].sort();
  return ids;
}

/** The ledger entry a finalized release appends: the frozen identity, the ids it shipped, sha256 per archive file name. */
export function ledgerEntryFor(product: ProductRecord, version: string, ids: PackIds, artifacts: readonly ArtifactSum[]): IdentityLedgerEntry {
  return {
    product: product.id,
    version,
    namespace: product.identity.namespace!,
    uuids: product.identity.uuids,
    ...ids,
    sha256: Object.fromEntries(artifacts.map(a => [a.file.split('/').pop()!, a.sha256])),
  };
}

/** What `finalize` records beside a prepared release (`finalize.json`). */
export interface FinalizeRecord {
  product: string;
  version: string;
  tag: string;
  tagCommit: string;
  preparedCommit: string;
  /** Where the identical rebuild was written. */
  rebuild: string;
  artifacts: ArtifactSum[];
  deviceEvidence: string | null;
}

/** One prepared output folder (`output/releases/<product>/<version>`), as read from disk. */
export interface PreparedFolder {
  product: string;
  version: string;
  release?: ReleasedVersion;
  finalize?: Pick<FinalizeRecord, 'tag' | 'tagCommit' | 'deviceEvidence'>;
}

export interface VersionStatus {
  version: string;
  prepared: boolean;
  finalized: boolean;
  /** In the identity ledger: the user committed the finalize. */
  released: boolean;
  tag: string | null;
  commit: string | null;
  deviceEvidence: string | null;
}
export interface ProductStatus { product: string; versions: VersionStatus[] }

const semverKey = (v: string): number[] => v.split('.').map(Number);
const byVersion = (a: VersionStatus, b: VersionStatus): number => {
  const [x, y] = [semverKey(a.version), semverKey(b.version)];
  return (x[0]! - y[0]!) || (x[1]! - y[1]!) || (x[2]! - y[2]!);
};

/** Every product's prepared, finalized and released versions, from the ledger and the output folders. */
export function releaseStatus(products: readonly string[], ledger: ReadonlyArray<Pick<IdentityLedgerEntry, 'product' | 'version'>>, folders: readonly PreparedFolder[]): ProductStatus[] {
  return products.map(product => {
    const rows = new Map<string, VersionStatus>();
    const row = (version: string): VersionStatus => {
      let r = rows.get(version);
      if (!r) rows.set(version, r = { version, prepared: false, finalized: false, released: false, tag: null, commit: null, deviceEvidence: null });
      return r;
    };
    for (const e of ledger.filter(l => l.product === product)) row(e.version).released = true;
    for (const f of folders.filter(x => x.product === product)) {
      const r = row(f.version);
      r.prepared = f.release !== undefined;
      r.commit = f.release?.commit ?? null;
      if (f.finalize) { r.finalized = true; r.tag = f.finalize.tag; r.deviceEvidence = f.finalize.deviceEvidence; }
    }
    return { product, versions: [...rows.values()].sort(byVersion) };
  });
}

/** The status table, one line per version; a product with none says so. */
export function renderStatus(rows: readonly ProductStatus[]): string {
  const lines: string[] = [];
  for (const p of rows) {
    if (p.versions.length === 0) { lines.push(`${p.product.padEnd(12)} no version prepared or released`); continue; }
    for (const v of p.versions) {
      lines.push([
        `${p.product} ${v.version}`.padEnd(18),
        (v.prepared ? 'prepared' : '-').padEnd(10),
        (v.finalized ? 'finalized' : '-').padEnd(11),
        (v.released ? 'released' : '-').padEnd(10),
        v.tag ? `tag ${v.tag}` : '', v.commit ? `commit ${v.commit.slice(0, 10)}` : '', v.deviceEvidence ? `device ${v.deviceEvidence}` : '',
      ].join(' ').trimEnd());
    }
  }
  return `${lines.join('\n')}\n`;
}
