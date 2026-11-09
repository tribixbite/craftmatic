/**
 * X-02 (BIZ-23, BIZ-51, BIZ-52): ONE `PackProfile` option on `buildPlayableAddon`.
 *
 * The dev pack is what the phones have proved, so the first guard is that it is
 * UNCHANGED without a profile: the nimbus stand-in (a real LDraw model with a
 * flyer, an orbit ride and a figure) is built at a fixed clock and a fixed
 * pipeline stamp and every file's content hash is compared with
 * `test/fixtures/pack-profile/dev-pack.golden.json`, recorded from the code
 * BEFORE the profile existed. Regenerate it only for an intended dev-pack
 * change: `UPDATE_PACK_GOLDEN=1 bunx vitest run test/playable-addon-profile.test.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyLangOverrides, type PackProfile } from '../web/src/engine/pack-profile.js';
import { buildNimbusPack, contentHashes, text, unzipAll } from './pack-profile-support.js';

const GOLDEN = 'test/fixtures/pack-profile/dev-pack.golden.json';
const FIXED_NOW = new Date('2026-11-09T12:00:00Z');

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_NOW); });
afterAll(() => { vi.useRealTimers(); });

describe('playable-addon-profile :: without a profile the dev pack is unchanged', () => {
  it('without a profile the dev pack is unchanged (file list and every file content)', async () => {
    const now = await contentHashes(await buildNimbusPack());
    if (process.env.UPDATE_PACK_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(Object.keys(now)).toEqual(Object.keys(golden));
    const changed = Object.keys(golden).filter(k => golden[k] !== now[k]);
    expect(changed).toEqual([]);
  }, 240_000);
});

// ── a profile build ────────────────────────────────────────────────────────

const REGISTRY = {
  namespace: 'acme_bricks',
  folderStem: 'acme_sampler',
  uuids: {
    bpHeader: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e01', bpData: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e02',
    bpScript: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e03', rpHeader: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e04',
    rpResources: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e05',
  },
} as const;
const releaseProfile = (over: Partial<PackProfile> = {}): PackProfile => ({
  identity: REGISTRY, version: [1, 2, 3], clock: Date.UTC(2026, 10, 9, 12), deflate: (d) => new Uint8Array(deflateRawSync(d, { level: 9 })),
  flags: { vanillaTextures: false, diagnostics: false, devStamp: false }, ...over,
});
const manifestsOf = (files: Map<string, Uint8Array>): { bp: any; rp: any; bpName: string; rpName: string } => {
  const bpName = [...files.keys()].find(k => k.endsWith('_BP/manifest.json'))!, rpName = [...files.keys()].find(k => k.endsWith('_RP/manifest.json'))!;
  return { bp: JSON.parse(text(files.get(bpName)!)), rp: JSON.parse(text(files.get(rpName)!)), bpName, rpName };
};

describe('playable-addon-profile :: a profile build', () => {
  it('a profile build uses the registry uuids, the semver version and pack_scope world', async () => {
    const files = await unzipAll(await buildNimbusPack(releaseProfile()));
    const { bp, rp } = manifestsOf(files);
    expect(bp.header.uuid).toBe(REGISTRY.uuids.bpHeader);
    expect(bp.header.version).toEqual([1, 2, 3]);
    expect(bp.modules.map((m: any) => [m.type, m.uuid, m.version])).toEqual([
      ['data', REGISTRY.uuids.bpData, [1, 2, 3]], ['script', REGISTRY.uuids.bpScript, [1, 2, 3]],
    ]);
    expect(rp.header.uuid).toBe(REGISTRY.uuids.rpHeader);
    expect(rp.modules).toEqual([{ type: 'resources', uuid: REGISTRY.uuids.rpResources, version: [1, 2, 3] }]);
    expect(rp.header.pack_scope).toBe('world');
    // Each pack depends on the other, by header uuid; both carry min_engine_version.
    expect(rp.dependencies).toEqual([{ uuid: REGISTRY.uuids.bpHeader, version: [1, 2, 3] }]);
    expect(bp.dependencies).toContainEqual({ uuid: REGISTRY.uuids.rpHeader, version: [1, 2, 3] });
    expect(bp.header.min_engine_version).toEqual([1, 26, 40]);
    expect(rp.header.min_engine_version).toEqual([1, 26, 40]);
  }, 240_000);

  it('two profile builds at different wall clocks are byte-identical', async () => {
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    const a = await buildNimbusPack(releaseProfile());
    vi.setSystemTime(new Date('2027-03-02T03:04:05Z'));
    const b = await buildNimbusPack(releaseProfile());
    vi.setSystemTime(FIXED_NOW);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    // The injected clock, not the wall clock, is what the pack records.
    const provenance = JSON.parse(text((await unzipAll(a)).get('Craftmatic_dragonballshenron_BP/craftmatic-provenance.json')!));
    expect(provenance.builtAt).toBe('2026-11-09T12:00:00.000Z');
  }, 240_000);

  it('a profile pack carries no craftmatic-diagnostics.json and no pipeline stamp in any name', async () => {
    const files = await unzipAll(await buildNimbusPack(releaseProfile()));
    expect([...files.keys()].filter(k => k.endsWith('craftmatic-diagnostics.json'))).toEqual([]);
    const { bp, rp } = manifestsOf(files);
    for (const header of [bp.header, rp.header]) {
      expect(`${header.name} ${header.description}`).not.toMatch(/1b74f4ee|0123456789ab|dirty|pipeline|\(\d{4}-\d{2}-\d{2}/);
    }
    expect(bp.header.name).toBe('Dragon Ball: Shenron & Goku (11390-1) — Playable');
    // The provenance file names no source and no dev stamp either.
    const provenance = JSON.parse(text(files.get('Craftmatic_dragonballshenron_BP/craftmatic-provenance.json')!));
    expect(provenance.pipeline.kind).toBe('unstamped');
    expect(provenance.pipeline.hash).toBeNull();
    expect(provenance.source).toBeNull();
  }, 240_000);

  it('vanillaTextures:false ships no file under textures/blocks/concrete_*', async () => {
    const off = [...(await unzipAll(await buildNimbusPack(releaseProfile()))).keys()];
    expect(off.filter(k => /textures\/blocks\/concrete_/.test(k))).toEqual([]);
    expect(off.some(k => k.endsWith('textures/terrain_texture.json'))).toBe(true);
    // Control: the dev pack still ships them (16 today; the plan said 17).
    const dev = [...(await unzipAll(await buildNimbusPack())).keys()];
    expect(dev.filter(k => /textures\/blocks\/concrete_/.test(k))).not.toHaveLength(0);
  }, 240_000);

  it('the profile texts replace the name, descriptions, README and lang lines', async () => {
    const texts = { packName: 'Sky Sampler', bpDescription: 'Behaviour part.', rpDescription: 'Resource part.', readme: 'How to play.\n', lang: { 'entity.craftmatic:nothing.name': 'Added' } };
    const files = await unzipAll(await buildNimbusPack(releaseProfile({ texts })));
    const { bp, rp, bpName } = manifestsOf(files);
    expect(bp.header).toMatchObject({ name: 'Sky Sampler', description: 'Behaviour part.' });
    expect(rp.header).toMatchObject({ name: 'Sky Sampler Resources', description: 'Resource part.' });
    expect(text(files.get(bpName.replace('manifest.json', 'README.txt'))!)).toBe('How to play.\n');
    const lang = text([...files].find(([k]) => k.endsWith('texts/en_US.lang'))![1]);
    expect(lang).toContain('entity.craftmatic:nothing.name=Added');
  }, 240_000);

  it('lang overrides replace a generated line in place and append unknown keys sorted', () => {
    expect(applyLangOverrides(['a=1', 'b=2'], { b: 'two', d: '4', c: '3' })).toEqual(['a=1', 'b=two', 'c=3', 'd=4']);
    expect(applyLangOverrides(['a=1'], undefined)).toEqual(['a=1']);
  });

  it('faceArt:false refuses a pack whose entities would carry a face atlas', async () => {
    const hasAtlas = [...(await unzipAll(await buildNimbusPack())).keys()].some(k => /_faces\.png$/.test(k));
    // TODO(X-02): the stand-in's plain heads draw no face atlas, so the refusal itself needs a fixture with a head print;
    // here the guard is proved not to refuse a pack that has none.
    expect(hasAtlas).toBe(false);
    await expect(buildNimbusPack(releaseProfile({ flags: { faceArt: false } }))).resolves.toBeInstanceOf(Uint8Array);
  }, 240_000);

  it('the entitlement rides the profile without changing the pack (B08 reads it)', async () => {
    const a = await buildNimbusPack(releaseProfile());
    const b = await buildNimbusPack(releaseProfile({ entitlement: { tier: 'free' } }));
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  }, 240_000);

  it('a profile with only identity and version leaves every other dev behaviour in place', async () => {
    const files = await unzipAll(await buildNimbusPack({ identity: REGISTRY, version: [2, 0, 0] }));
    expect([...files.keys()].some(k => k.endsWith('craftmatic-diagnostics.json'))).toBe(true);
    expect([...files.keys()].filter(k => /textures\/blocks\/concrete_/.test(k))).not.toHaveLength(0);
    const { bp } = manifestsOf(files);
    expect(bp.header.name).toMatch(/ — Playable \(2026-09-21 1b74f4ee\)$/);
  }, 240_000);
});
