import { assertReleasable, UUID_SLOTS } from './product.js';
import { compareSemVer, parseSemVer } from './semver.js';
import type { IdentityLedgerEntry, ProductRecord, ReleaseBuildIdentity, SemVer } from './types.js';

/** The three id lists an entry freezes, with the noun used in messages. */
const ID_LISTS = [['entityIds', 'entity'], ['blockIds', 'block'], ['itemIds', 'item']] as const;

const lastOf = (ledger: readonly IdentityLedgerEntry[], product: string): IdentityLedgerEntry | undefined =>
  ledger.filter(e => e.product === product).at(-1);

/**
 * Problems appending `entry` after `ledger` would cause (empty = allowed).
 * Rules: the version rises above the product's last; namespace and uuids equal
 * the last entry's (and the registry's, when given); no entity, block or item id
 * the last version shipped is missing. Ids are compared with the LAST entry
 * only, which is enough because each entry must itself contain its predecessor's.
 */
export function checkLedgerAppend(ledger: readonly IdentityLedgerEntry[], entry: IdentityLedgerEntry, product?: ProductRecord): string[] {
  const out: string[] = [];
  let version: SemVer | null = null;
  try { version = parseSemVer(entry.version); } catch (e) { out.push((e as Error).message); }
  if (typeof entry.namespace !== 'string' || entry.namespace === '') out.push('entry namespace is empty');
  for (const [key, noun] of ID_LISTS) {
    if (new Set(entry[key]).size !== entry[key].length) out.push(`duplicate ${noun} ids in ${key}`);
  }
  for (const [file, hash] of Object.entries(entry.sha256)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) out.push(`sha256 of ${file} is not 64 hex digits`);
  }
  if (product) {
    if (product.id !== entry.product) out.push(`entry is for ${entry.product}, registry product is ${product.id}`);
    if (product.identity.namespace !== entry.namespace) out.push(`entry namespace ${entry.namespace} disagrees with the registry`);
    if (UUID_SLOTS.some(s => product.identity.uuids[s] !== entry.uuids[s])) out.push('entry uuids disagree with the registry');
  }
  const last = lastOf(ledger, entry.product);
  if (last && version) {
    if (compareSemVer(version, parseSemVer(last.version)) <= 0) out.push(`version ${entry.version} must rise above ${last.version}`);
    if (last.namespace !== entry.namespace) out.push(`namespace is frozen: ${last.namespace} -> ${entry.namespace}`);
    for (const slot of UUID_SLOTS) {
      if (last.uuids[slot] !== entry.uuids[slot]) out.push(`uuid ${slot} is frozen and changed`);
    }
    for (const [key, noun] of ID_LISTS) {
      for (const id of last[key]) {
        if (!entry[key].includes(id)) out.push(`${noun} id ${id} shipped in ${last.version} and may not be dropped`);
      }
    }
  }
  return out;
}

/** Append-only: returns a NEW ledger with the entry added, or throws listing every violated rule. */
export function appendLedgerEntry(ledger: readonly IdentityLedgerEntry[], entry: IdentityLedgerEntry, product?: ProductRecord): IdentityLedgerEntry[] {
  const problems = checkLedgerAppend(ledger, entry, product);
  if (problems.length > 0) throw new Error(`identity ledger refuses ${entry.product} ${entry.version}: ${problems.join('; ')}`);
  return [...ledger, entry];
}

/** Replays a whole ledger through the append rules; empty = every entry is legal after its predecessors. */
export function ledgerProblems(ledger: readonly IdentityLedgerEntry[]): string[] {
  const out: string[] = [];
  ledger.forEach((entry, i) => {
    for (const p of checkLedgerAppend(ledger.slice(0, i), entry)) out.push(`${entry.product} ${entry.version}: ${p}`);
  });
  return out;
}

/**
 * The identity a release build of `version` must use: the registry's frozen
 * namespace, folder and uuids. Refuses a null namespace and a version that does
 * not rise above the product's last ledger entry.
 */
export function releaseBuildIdentity(product: ProductRecord, version: SemVer, ledger: readonly IdentityLedgerEntry[]): ReleaseBuildIdentity {
  const identity = assertReleasable(product);
  const last = lastOf(ledger, product.id);
  if (last) {
    if (compareSemVer(version, parseSemVer(last.version)) <= 0) {
      throw new Error(`version ${version.major}.${version.minor}.${version.patch} must rise above released ${last.version}`);
    }
    if (last.namespace !== identity.namespace || UUID_SLOTS.some(s => last.uuids[s] !== identity.uuids[s])) {
      throw new Error(`registry identity of ${product.id} no longer matches the ledger (namespace and uuids are frozen)`);
    }
  }
  return { version, identity };
}
