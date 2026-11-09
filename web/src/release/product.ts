import { deterministicUuid } from '../engine/mcpack.js';
import { compareSemVer } from './semver.js';
import type { DevIdentity, ProductIdentity, ProductRecord, ProductUuids } from './types.js';

/** Product ids are file names and tags: lowercase, digits and dashes, no leading digit. */
export const PRODUCT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** A namespace is a Bedrock id prefix: lowercase, digits, underscores, no leading digit. */
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Namespaces no release may use: the dev pipeline's own, and Mojang's. */
export const RESERVED_NAMESPACES: readonly string[] = ['craftmatic', 'minecraft'];
/** A random (version 4, variant 10xx) uuid in canonical lowercase form. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The five uuid slots, in a fixed order. */
export const UUID_SLOTS: ReadonlyArray<keyof ProductUuids> = ['bpHeader', 'bpData', 'bpScript', 'rpHeader', 'rpResources'];
const FOLDER_STEM = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Structural problems of one namespace value (null is legal in the registry, illegal in a release). */
export function namespaceProblems(ns: string): string[] {
  if (!NAMESPACE_PATTERN.test(ns)) return [`namespace ${JSON.stringify(ns)} must match ${NAMESPACE_PATTERN}`];
  if (RESERVED_NAMESPACES.includes(ns)) return [`namespace ${JSON.stringify(ns)} is reserved`];
  return [];
}

/** Every problem with a product record; an empty list means it is well formed. Null namespace is NOT a problem here. */
export function validateProduct(p: ProductRecord): string[] {
  const out: string[] = [];
  if (typeof p.id !== 'string' || !PRODUCT_ID_PATTERN.test(p.id)) out.push(`id must match ${PRODUCT_ID_PATTERN}`);
  if (typeof p.displayName !== 'string' || p.displayName.trim() === '') out.push('displayName is empty');
  if (p.tier !== 'free' && p.tier !== 'paid-marketplace') out.push(`tier ${String(p.tier)} is unknown`);
  const id = p.identity;
  if (id.namespace !== null) out.push(...namespaceProblems(id.namespace));
  if (!FOLDER_STEM.test(id.folderStem)) out.push(`folderStem ${JSON.stringify(id.folderStem)} must match ${FOLDER_STEM}`);
  const values = UUID_SLOTS.map(slot => id.uuids[slot]);
  UUID_SLOTS.forEach((slot, i) => {
    if (typeof values[i] !== 'string' || !UUID_V4.test(values[i]!)) out.push(`uuid ${slot} is not a lowercase v4 uuid`);
  });
  if (new Set(values).size !== values.length) out.push('the five uuids must be distinct (manifest validation needs distinct header and module uuids)');
  for (let i = 1; i < p.versions.length; i++) {
    if (compareSemVer(p.versions[i - 1]!.version, p.versions[i]!.version) >= 0) out.push('versions must strictly rise, newest last');
  }
  return out;
}

/** Parse registry JSON into a validated record; throws "invalid product" listing every problem. */
export function parseProduct(json: string): ProductRecord {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) { throw new Error(`invalid product: not JSON (${(e as Error).message})`); }
  const p = raw as Partial<ProductRecord> | null;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.displayName !== 'string' || !p.identity
    || typeof p.identity !== 'object' || !p.identity.uuids || !Array.isArray(p.versions) || !Array.isArray(p.placeholders)
    || !Array.isArray(p.designs) || !p.toolchain) {
    throw new Error('invalid product: missing id, displayName, identity, placeholders, designs, toolchain or versions');
  }
  const record = p as ProductRecord;
  const problems = validateProduct(record);
  if (problems.length > 0) throw new Error(`invalid product ${record.id}: ${problems.join('; ')}`);
  return record;
}

/** The identity a release build may use; throws while the namespace is undecided (U1) or malformed. */
export function assertReleasable(p: ProductRecord): ProductIdentity & { namespace: string } {
  const ns = p.identity.namespace;
  if (ns === null) throw new Error(`product ${p.id}: namespace is null (brand undecided, U1); a release build refuses it`);
  const problems = [...namespaceProblems(ns), ...validateProduct(p)];
  if (problems.length > 0) throw new Error(`product ${p.id} is not releasable: ${problems.join('; ')}`);
  return { ...p.identity, namespace: ns, uuids: { ...p.identity.uuids } };
}

/**
 * The identity of a DEV build of a product: every uuid re-derived with a `:dev`
 * salt (from the frozen uuid, never from the name) and a name and folder that
 * say "dev". A date-based dev version outranks [1,0,0], and Minecraft replaces
 * an installed pack only when the version rises, so a dev build sharing a
 * release's uuids would silently shadow it.
 *
 * @param stamp short build label shown in the pack name, e.g. a date or commit.
 */
export function devIdentity(p: ProductRecord, stamp: string): DevIdentity {
  const uuids = {} as ProductUuids;
  for (const slot of UUID_SLOTS) uuids[slot] = deterministicUuid(`${p.identity.uuids[slot]}:dev`);
  return {
    identity: { namespace: p.identity.namespace, folderStem: `${p.identity.folderStem}Dev`, uuids },
    displayName: `${p.displayName} (dev ${stamp})`,
  };
}
