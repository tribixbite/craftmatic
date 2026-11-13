/**
 * RB (BIZ-24 / BIZ-54): a RELEASE build lays its files out the way Microsoft's validator (`mct validate`) wants.
 *
 * Each case below is one mct finding of the 2026-11-13 fixture release, pinned at its cause:
 *   PRJINT:101   no README / DISCLAIMER / CREDITS / CHANGELOG inside a pack      (flags.packNotes, release.ts bundle)
 *   UNKJSON:101  no provenance / treads JSON inside a pack                       (flags.packNotes, flags.diagnostics)
 *   CPACKICON    a 256x256 pack_icon.png in BOTH packs                           (flags.packIcons, marketplace/pack-icon.ts)
 *   CADDONREQ    textures/<creator>/<pack>/..., cameras/presets/<creator>/<pack>/ (rewrite.ts)
 *   JSON:193     terrain_texture.json `textures` is an array                     (rewrite.ts)
 *   PATHLENGTH   every path at most 100 characters, release builds only          (rewrite.ts)
 * The dev pack is untouched: the golden in playable-addon-profile.test.ts proves it byte for byte.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packIconPng, PACK_ICON_SIZE } from '../web/src/engine/marketplace/pack-icon.js';
import { MAX_PACK_PATH, rewritePack, type PackFile } from '../web/src/engine/marketplace/rewrite.js';
import { resolvePackFlags } from '../web/src/engine/pack-profile.js';
import { RELEASE_PROFILE_FLAGS } from '../web/src/release/prepare.js';
import { buildNimbusPack, unzipAll } from './pack-profile-support.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (d: Uint8Array): string => new TextDecoder().decode(d);
const deflate = (d: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(d, { level: 9 }));
const OPTS = { creator: 'cmt', pack: 'test', rootStem: 'CmtTest' } as const;

/** A tiny dev pack: one entity, one block, textures in the vanilla-shaped folders, a camera preset and a long name. */
function devPack(): PackFile[] {
  const manifest = (type: string): Uint8Array => enc(JSON.stringify({ format_version: 2, header: { name: 'x', uuid: type === 'data' ? 'a' : 'b', version: [1, 0, 0] }, modules: [{ type, uuid: 'c', version: [1, 0, 0] }] }));
  const longStem = 'b_910004_910004_shell_cn1_0_n1_with_a_very_long_generated_name_that_goes_on';
  return [
    { name: 'Craftmatic_t_BP/manifest.json', data: manifest('data') },
    { name: 'Craftmatic_t_RP/manifest.json', data: manifest('resources') },
    { name: 'Craftmatic_t_BP/cameras/presets/craftmatic_t_boom.json', data: enc('{"format_version":"1.20.50","minecraft:camera_preset":{"identifier":"craftmatic:t_boom"}}') },
    { name: 'Craftmatic_t_RP/entity/craftmatic_t_a.entity.json', data: enc('{"minecraft:client_entity":{"description":{"identifier":"craftmatic:t_a","textures":{"default":"textures/entity/craftmatic_t_a/skin"},"geometry":{"default":"geometry.craftmatic.a"},"render_controllers":["controller.render.craftmatic.a"]}}}') },
    { name: 'Craftmatic_t_RP/textures/entity/craftmatic_t_a/skin.png', data: Uint8Array.of(1, 2, 3) },
    { name: 'Craftmatic_t_RP/textures/blocks/craftmatic_t_brick_red.png', data: Uint8Array.of(4, 5, 6) },
    { name: 'Craftmatic_t_RP/textures/terrain_texture.json', data: enc('{"texture_data":{"craftmatic_t_brick_red":{"textures":"textures/blocks/craftmatic_t_brick_red"}}}') },
    { name: 'Craftmatic_t_RP/models/entity/craftmatic_t_a.geo.json', data: enc('{"minecraft:geometry":[{"description":{"identifier":"geometry.craftmatic.a"}}]}') },
    { name: `Craftmatic_t_RP/render_controllers/${longStem}.render_controllers.json`, data: enc('{"render_controllers":{"controller.render.craftmatic.a":{}}}') },
  ];
}

describe('release pack layout :: profile flags', () => {
  it('a release profile ships no pack notes and brands both packs; the dev default is unchanged', () => {
    expect(resolvePackFlags(undefined)).toMatchObject({ packNotes: true, packIcons: false });
    expect(RELEASE_PROFILE_FLAGS).toMatchObject({ packNotes: false, packIcons: true });
  });
});

describe('release pack layout :: a release build of the nimbus stand-in', () => {
  it('has no README, provenance or treads JSON in a pack, and the same 256x256 icon in both', async () => {
    const files = await unzipAll(await buildNimbusPack({
      identity: { namespace: 'acme_bricks', folderStem: 'acme_sampler', uuids: { bpHeader: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e01', bpData: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e02', bpScript: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e03', rpHeader: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e04', rpResources: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e05' } },
      version: [1, 0, 0], clock: Date.UTC(2026, 10, 9, 12), deflate, flags: { ...RELEASE_PROFILE_FLAGS, faceArt: true },
    }));
    const names = [...files.keys()];
    expect(names.filter(n => /(README|provenance|treads|diagnostics)/i.test(n))).toEqual([]);
    const icons = names.filter(n => n.endsWith('/pack_icon.png'));
    expect(icons.length).toBe(2);
    for (const n of icons) {
      const png = files.get(n)!;
      expect([new DataView(png.buffer, png.byteOffset).getUint32(16), new DataView(png.buffer, png.byteOffset).getUint32(20)]).toEqual([256, 256]);
    }
    expect(Buffer.from(files.get(icons[0]!)!).equals(Buffer.from(files.get(icons[1]!)!))).toBe(true);
  }, 240_000);
});

describe('release pack layout :: the pack icon', () => {
  it('is a 256x256 RGBA PNG that is small, deterministic and per product', () => {
    const a = packIconPng('cmt_sampler', deflate);
    expect([...a.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(a.buffer, a.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([PACK_ICON_SIZE, PACK_ICON_SIZE]);
    expect(PACK_ICON_SIZE).toBe(256);
    expect(a.length).toBeLessThan(40_000);
    expect(Buffer.from(packIconPng('cmt_sampler', deflate)).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(packIconPng('cmt_other', deflate)).equals(Buffer.from(a))).toBe(false);
  });
});

describe('release pack layout :: the rewrite', () => {
  it('moves every texture under textures/<creator>/<pack>/ and re-points the entity at it', () => {
    const { files } = rewritePack(devPack(), OPTS);
    const names = files.map(f => f.name);
    const textures = names.filter(n => /\.(png|tga)$/.test(n));
    expect(textures.length).toBe(2);
    for (const t of textures) expect(t.startsWith('CmtTest_RP/textures/cmt/test/'), t).toBe(true);
    expect(names.some(n => /textures\/(blocks|entity)\//.test(n))).toBe(false);
    const entity = dec(files.find(f => f.name.includes('/entity/'))!.data);
    expect(entity).toContain('textures/cmt/test/entity/cmt_test_t_a/skin');
    expect(names).toContain('CmtTest_RP/textures/cmt/test/entity/cmt_test_t_a/skin.png');
  });

  it('writes terrain_texture.json textures as arrays', () => {
    const { files } = rewritePack(devPack(), OPTS);
    const atlas = JSON.parse(dec(files.find(f => f.name.endsWith('textures/terrain_texture.json'))!.data)) as { texture_data: Record<string, { textures: unknown }> };
    expect(atlas.texture_data.cmt_test_t_brick_red!.textures).toEqual(['textures/cmt/test/blocks/cmt_test_t_brick_red']);
    expect(names(files)).toContain('CmtTest_RP/textures/cmt/test/blocks/cmt_test_t_brick_red.png');
  });

  it('puts camera presets under cameras/presets/<creator>/<pack>/', () => {
    const { files } = rewritePack(devPack(), OPTS);
    expect(names(files)).toContain('CmtTest_BP/cameras/presets/cmt/test/cmt_test_t_boom.json');
  });

  it('shortens a path over 100 characters, deterministically, and leaves short ones alone', () => {
    const first = rewritePack(devPack(), OPTS).files;
    const second = rewritePack(devPack(), OPTS).files;
    expect(names(first)).toEqual(names(second));
    for (const n of names(first)) expect(n.length, n).toBeLessThanOrEqual(MAX_PACK_PATH);
    expect(MAX_PACK_PATH).toBe(100);
    expect(names(first)).toContain('CmtTest_RP/entity/cmt/test/cmt_test_t_a.entity.json');
    // the shortened file keeps its double extension so the game still reads it as a render controller
    expect(names(first).some(n => n.startsWith('CmtTest_RP/render_controllers/cmt/test/') && n.endsWith('.render_controllers.json'))).toBe(true);
  });
});

const names = (files: readonly PackFile[]): string[] => files.map(f => f.name);
