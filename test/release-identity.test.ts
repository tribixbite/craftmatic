import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bumpSemVer, compareSemVer, formatSemVer, parseSemVer, toManifestTriple } from '../web/src/release/semver.js';
import { assertReleasable, devIdentity, parseProduct, validateProduct } from '../web/src/release/product.js';
import { appendLedgerEntry, ledgerProblems, releaseBuildIdentity } from '../web/src/release/identity-ledger.js';
import type { IdentityLedgerEntry, ProductRecord } from '../web/src/release/types.js';

const UUIDS = {
  bpHeader: '11111111-1111-4111-8111-111111111111', bpData: '22222222-2222-4222-8222-222222222222',
  bpScript: '33333333-3333-4333-8333-333333333333', rpHeader: '44444444-4444-4444-8444-444444444444',
  rpResources: '55555555-5555-4555-8555-555555555555',
};
/** A fixture product whose namespace is a TEST value, not the brand. */
const product = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  id: 'fixture', displayName: 'Fixture Pack', tier: 'free', placeholders: [],
  identity: { namespace: 'tst', folderStem: 'FixturePack', uuids: { ...UUIDS } },
  designs: [],
  toolchain: {
    bun: '1.3.11', lockfileSha256: 'a'.repeat(64),
    ldrawLibrary: { archive: 'complete.zip', sha256: null, root: 'ldraw_ref/official' },
    scriptModules: { server: '2.9.0', serverUi: '2.1.0' }, minEngineVersion: [1, 26, 40],
  },
  versions: [], publisher: null, ...over,
});
const entry = (version: string, over: Partial<IdentityLedgerEntry> = {}): IdentityLedgerEntry => ({
  product: 'fixture', version, namespace: 'tst', uuids: { ...UUIDS },
  entityIds: ['tst:car'], blockIds: ['tst:collider'], itemIds: ['tst:wand'], sha256: { 'fixture.mcaddon': 'b'.repeat(64) }, ...over,
});

describe('release identity', () => {
  it('the same product at 1.0.0 and 1.1.0 keeps every uuid', () => {
    const p = product();
    const first = releaseBuildIdentity(p, parseSemVer('1.0.0'), []);
    const ledger = appendLedgerEntry([], entry('1.0.0'), p);
    const second = releaseBuildIdentity(p, parseSemVer('1.1.0'), ledger);
    expect(second.identity.uuids).toEqual(first.identity.uuids);
    expect(second.identity.uuids).toEqual(UUIDS);
    expect(second.identity.namespace).toBe('tst');
    expect(second.identity.folderStem).toBe(first.identity.folderStem);
  });

  it('a version that does not rise is refused', () => {
    const p = product();
    const ledger = appendLedgerEntry([], entry('1.2.0'), p);
    expect(() => appendLedgerEntry(ledger, entry('1.2.0'), p)).toThrow(/rise/);
    expect(() => appendLedgerEntry(ledger, entry('1.1.9'), p)).toThrow(/rise/);
    expect(() => releaseBuildIdentity(p, parseSemVer('1.2.0'), ledger)).toThrow(/rise/);
    expect(() => releaseBuildIdentity(p, parseSemVer('1.10.0'), ledger)).not.toThrow(); // numeric, not lexical
  });

  it('dropping an entity id a released version shipped is refused', () => {
    const p = product();
    const ledger = appendLedgerEntry([], entry('1.0.0'), p);
    expect(() => appendLedgerEntry(ledger, entry('1.1.0', { entityIds: [] }), p)).toThrow(/tst:car/);
    expect(() => appendLedgerEntry(ledger, entry('1.1.0', { blockIds: [] }), p)).toThrow(/tst:collider/);
    expect(() => appendLedgerEntry(ledger, entry('1.1.0', { itemIds: [] }), p)).toThrow(/tst:wand/);
    // Adding ids is fine.
    const grown = appendLedgerEntry(ledger, entry('1.1.0', { entityIds: ['tst:car', 'tst:boat'] }), p);
    expect(ledgerProblems(grown)).toEqual([]);
  });

  it('refuses a changed namespace or uuid across versions', () => {
    const p = product();
    const ledger = appendLedgerEntry([], entry('1.0.0'), p);
    expect(() => appendLedgerEntry(ledger, entry('1.1.0', { namespace: 'other' }), p)).toThrow(/namespace/);
    expect(() => appendLedgerEntry(ledger, entry('1.1.0', { uuids: { ...UUIDS, bpData: UUIDS.rpHeader } }), p)).toThrow(/uuid/);
    // An entry that disagrees with the registry is refused even as the first one.
    expect(() => appendLedgerEntry([], entry('1.0.0', { namespace: 'other' }), p)).toThrow(/registry/);
  });

  it('a null namespace refuses a release build', () => {
    const p = product({ identity: { ...product().identity, namespace: null } });
    expect(() => assertReleasable(p)).toThrow(/namespace/);
    expect(() => releaseBuildIdentity(p, parseSemVer('1.0.0'), [])).toThrow(/namespace/);
    // A dev identity needs no namespace.
    expect(devIdentity(p, '2611-0101').identity.namespace).toBeNull();
  });

  it('dev identity uuids differ from release uuids and the dev name carries "(dev"', () => {
    const p = product();
    const dev = devIdentity(p, '2611-0101');
    const release = Object.values(p.identity.uuids);
    const devUuids = Object.values(dev.identity.uuids);
    expect(devUuids).toHaveLength(5);
    expect(new Set([...release, ...devUuids]).size).toBe(10);
    expect(dev.displayName).toContain('(dev');
    expect(dev.displayName).toContain('2611-0101');
    expect(dev.identity.folderStem).not.toBe(p.identity.folderStem);
    expect(devIdentity(p, '2611-0101')).toEqual(dev); // deterministic
    for (const u of devUuids) expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('semver maps to the manifest triple', () => {
    expect(toManifestTriple(parseSemVer('1.2.3'))).toEqual([1, 2, 3]);
    expect(formatSemVer({ major: 0, minor: 10, patch: 0 })).toBe('0.10.0');
    expect(compareSemVer(parseSemVer('1.10.0'), parseSemVer('1.9.9'))).toBeGreaterThan(0);
    expect(compareSemVer(parseSemVer('1.0.0'), parseSemVer('1.0.0'))).toBe(0);
    expect(bumpSemVer(parseSemVer('1.2.3'), 'minor')).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(bumpSemVer(parseSemVer('1.2.3'), 'major')).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(bumpSemVer(parseSemVer('1.2.3'), 'patch')).toEqual({ major: 1, minor: 2, patch: 4 });
    for (const bad of ['1.0', '1.0.0-beta', 'v1.0.0', '01.0.0', '1.0.0.0', '', '-1.0.0']) expect(() => parseSemVer(bad)).toThrow(RangeError);
    expect(() => toManifestTriple({ major: 1.5, minor: 0, patch: 0 })).toThrow(RangeError);
  });

  it('uuids are not derived from the display name', () => {
    const a = product();
    const b = product({ displayName: 'A Completely Different Name' });
    expect(b.identity.uuids).toEqual(a.identity.uuids);
    expect(releaseBuildIdentity(b, parseSemVer('1.0.0'), []).identity.uuids).toEqual(UUIDS);
    expect(Object.values(devIdentity(a, 's').identity.uuids)).toEqual(Object.values(devIdentity(b, 's').identity.uuids));
  });

  it('validateProduct rejects malformed identities', () => {
    expect(validateProduct(product())).toEqual([]);
    const dup = product({ identity: { ...product().identity, uuids: { ...UUIDS, rpResources: UUIDS.bpHeader } } });
    expect(validateProduct(dup).join('\n')).toMatch(/distinct/);
    expect(validateProduct(product({ identity: { ...product().identity, namespace: '1bad' } })).join('\n')).toMatch(/namespace/);
    expect(validateProduct(product({ identity: { ...product().identity, namespace: 'craftmatic' } })).join('\n')).toMatch(/namespace/);
    const notV4 = product({ identity: { ...product().identity, uuids: { ...UUIDS, bpData: 'not-a-uuid' } } });
    expect(validateProduct(notV4).join('\n')).toMatch(/uuid/);
    expect(() => parseProduct('{"id": 3}')).toThrow(/invalid product/);
  });
});

describe('release.ts init-product', () => {
  const run = (root: string, ...args: string[]) =>
    spawnSync('bun', [join(process.cwd(), 'scripts', 'release.ts'), ...args], { encoding: 'utf8', env: { ...process.env, CRAFTMATIC_RELEASE_ROOT: root } });

  it('init-product refuses to overwrite an existing product', () => {
    const root = mkdtempSync(join(tmpdir(), 'x01-'));
    mkdirSync(join(root, 'release', 'products'), { recursive: true });
    writeFileSync(join(root, 'bun.lock'), 'lock fixture');
    const first = run(root, 'init-product', 'sampler');
    expect(first.status, first.stderr).toBe(0);
    const file = join(root, 'release', 'products', 'sampler.json');
    expect(existsSync(file)).toBe(true);
    const minted = readFileSync(file, 'utf8');
    const record = parseProduct(minted);
    expect(record.identity.namespace).toBeNull();
    expect(record.placeholders).toContain('namespace');
    expect(validateProduct(record)).toEqual([]);
    const second = run(root, 'init-product', 'sampler');
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already exists/);
    expect(readFileSync(file, 'utf8')).toBe(minted); // untouched
    const bad = run(root, 'init-product', 'Bad Id');
    expect(bad.status).not.toBe(0);
  }, 30_000);
});

describe('committed registry', () => {
  it('release/products/*.json validate, uuids are unique across products, and the ledger is clean', () => {
    const dir = join(process.cwd(), 'release', 'products');
    const files = ['sampler.json'];
    const seen = new Set<string>();
    for (const f of files) {
      const record = parseProduct(readFileSync(join(dir, f), 'utf8'));
      expect(validateProduct(record)).toEqual([]);
      for (const u of Object.values(record.identity.uuids)) { expect(seen.has(u)).toBe(false); seen.add(u); }
    }
    const ledger = JSON.parse(readFileSync(join(process.cwd(), 'release', 'identity-ledger.json'), 'utf8')) as IdentityLedgerEntry[];
    expect(ledgerProblems(ledger)).toEqual([]);
  });
});
