/**
 * M03 (BIZ-23, plan A 7.3): a Marketplace pack ships its OWN brick blocks instead of overwriting vanilla concrete,
 * and its collider blocks fit the 10,000 permutation limit.
 *
 * The dev pack is what the phones proved, so both changes sit behind two `PackProfile` flags
 * (`brickBlocks`, `compactColliderStates`) that default to the dev pack's value (off); the dev pack's golden hashes
 * (`test/playable-addon-profile.test.ts`) keep guarding it. This file guards the profile side: every collision box
 * the compact encoding ships is exactly the one the legacy encoding ships, and the pack stays inside the budget.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { PackProfile } from '../web/src/engine/pack-profile.js';
import { countBlockPermutations, PLATFORM_LIMITS } from '../web/src/engine/marketplace/budget.js';
import {
  BRICK_BLOCK_COLOURS, BRICK_BLOCK_KINDS, VANILLA_CONCRETE_TEXTURE_PATHS, brickBlockDefinition, brickBlockId, brickBlockTextures,
} from '../web/src/engine/marketplace/blocks.js';
import { COLLIDER_KIT, colliderBlockDefinition, colliderFormKit, type ColliderStateEncoding } from '../web/src/engine/collider-form.js';
import { CONCRETE_COLORS } from '../web/src/engine/lego-resource-pack.js';
import { buildNimbusPack, text, unzipAll } from './pack-profile-support.js';

const REGISTRY = {
  namespace: 'acme_bricks', folderStem: 'acme_sampler',
  uuids: {
    bpHeader: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e01', bpData: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e02',
    bpScript: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e03', rpHeader: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e04',
    rpResources: '3f6c1a52-9b1e-4d0a-8c77-0a1b2c3d4e05',
  },
} as const;
const profile = (flags: PackProfile['flags']): PackProfile => ({
  identity: REGISTRY, version: [1, 0, 0], clock: Date.UTC(2026, 10, 9, 12), deflate: d => new Uint8Array(deflateRawSync(d, { level: 9 })),
  flags: { vanillaTextures: false, diagnostics: false, devStamp: false, ...flags },
});

/** The block definitions (`blocks/*.json` of the behaviour pack) of a built archive. */
const blockFiles = (files: Map<string, Uint8Array>): Array<{ path: string; json: unknown }> =>
  [...files].filter(([n]) => /(^|\/)blocks\/.+\.json$/.test(n) && n.includes('_BP/')).map(([path, data]) => ({ path, json: JSON.parse(text(data)) }));

/**
 * The collision boxes a block definition gives a state combination: the first `permutations` entry whose Molang condition
 * (`q.block_state('<name>') == <n> && ...`) every state satisfies, else the base `minecraft:collision_box`.
 */
function boxesFor(def: any, states: Record<string, number>): unknown {
  const block = def['minecraft:block'];
  for (const p of block.permutations ?? []) {
    const wants = [...String(p.condition).matchAll(/q\.block_state\('([^']+)'\)\s*==\s*(\d+)/g)].map(m => [m[1]!, Number(m[2])] as const);
    if (wants.length && wants.every(([k, v]) => states[k] === v)) return p.components['minecraft:collision_box'];
  }
  return block.components['minecraft:collision_box'];
}

describe('marketplace-blocks', () => {
  it('a profile pack ships no file at a vanilla texture path and its block permutations total at most 10000', async () => {
    const files = await unzipAll(await buildNimbusPack(profile({ brickBlocks: true, compactColliderStates: true })));
    const vanilla = [...files.keys()].filter(n => VANILLA_CONCRETE_TEXTURE_PATHS.some(p => n.endsWith(`${p}.png`)));
    expect(vanilla).toEqual([]);
    // Every block texture is our own (prefixed), none sits at a vanilla `concrete_<colour>` path.
    const blockTextures = [...files.keys()].filter(n => /\/textures\/blocks\/[^/]+\.png$/.test(n));
    for (const n of blockTextures) expect(n.split('/').pop()!.startsWith('craftmatic_'), n).toBe(true);
    const counted = countBlockPermutations(blockFiles(files));
    expect(counted.blocks.length).toBeGreaterThan(COLLIDER_KIT.VARIANTS.length);
    expect(counted.total).toBeLessThanOrEqual(PLATFORM_LIMITS.maxPermutations);
    // the baseline the encoding replaces: the same pack without the flag is over the limit
    const legacy = countBlockPermutations(blockFiles(await unzipAll(await buildNimbusPack(profile({ brickBlocks: true })))));
    expect(legacy.total).toBeGreaterThan(PLATFORM_LIMITS.maxPermutations);
  }, 240_000);

  it('the profile pack ships a brick block and a plate block of every colour, each textured with our own swatches', async () => {
    const files = await unzipAll(await buildNimbusPack(profile({ brickBlocks: true, compactColliderStates: true })));
    const ids = new Set(blockFiles(files).map(b => ((b.json as any)['minecraft:block'].description.identifier as string)));
    for (const colour of BRICK_BLOCK_COLOURS) for (const kind of BRICK_BLOCK_KINDS) expect(ids.has(brickBlockId('craftmatic', colour, kind)), `${kind}_${colour}`).toBe(true);
    const terrain = JSON.parse(text([...files].find(([n]) => n.endsWith('textures/terrain_texture.json'))![1])) as { texture_data: Record<string, { textures: string }> };
    for (const [key, t] of Object.entries(brickBlockTextures('craftmatic'))) {
      expect(terrain.texture_data[key]?.textures, key).toBe(t.textures);
      expect([...files.keys()].some(n => n.endsWith(`${t.textures}.png`)), `${t.textures}.png`).toBe(true);
    }
  }, 240_000);

  it('the dev pack (no flags) still ships the vanilla concrete overrides and no brick blocks', async () => {
    const files = await unzipAll(await buildNimbusPack());
    expect([...files.keys()].filter(n => /textures\/blocks\/concrete_/.test(n)).length).toBe(Object.keys(CONCRETE_COLORS).length);
    expect(blockFiles(files).some(b => /brick_|plate_/.test(String((b.json as any)['minecraft:block'].description.identifier)))).toBe(false);
    const counted = countBlockPermutations(blockFiles(files));
    expect(counted.total).toBe(COLLIDER_KIT.VARIANTS.length * 256);
  }, 240_000);
});

describe('marketplace-blocks :: brick block definitions', () => {
  it('a brick is a full cube with a studded top; a plate is a third of a cube and collides as one; neither has states', () => {
    for (const colour of BRICK_BLOCK_COLOURS) {
      const brick = brickBlockDefinition('craftmatic', colour, 'brick') as any, plate = brickBlockDefinition('craftmatic', colour, 'plate') as any;
      expect(brick['minecraft:block'].description.identifier).toBe(`craftmatic:brick_${colour}`);
      expect(plate['minecraft:block'].description.identifier).toBe(`craftmatic:plate_${colour}`);
      expect(brick['minecraft:block'].description.states).toBeUndefined();
      expect(plate['minecraft:block'].description.states).toBeUndefined();
      const bm = brick['minecraft:block'].components['minecraft:material_instances'], pm = plate['minecraft:block'].components['minecraft:material_instances'];
      expect(bm.up.texture).toBe(`craftmatic_brick_${colour}_top`);
      expect(bm['*'].texture).toBe(`craftmatic_brick_${colour}`);
      expect(pm).toEqual(bm);
      const box = plate['minecraft:block'].components['minecraft:collision_box'];
      expect(box.size[0]).toBe(16);
      expect(box.size[1]).toBeCloseTo(16 / 3, 3);
      expect(box.size[2]).toBe(16);
    }
  });
});

describe('marketplace-blocks :: the compact collider encoding keeps every form\'s boxes', () => {
  const ENCODINGS: ColliderStateEncoding[] = ['legacy', 'pair'];
  it('every variant at every (lo, hi) resolves to the same collision boxes under both encodings', () => {
    const kit = colliderFormKit();
    for (let v = 0; v < COLLIDER_KIT.VARIANTS.length; v++) {
      const [legacy, pair] = ENCODINGS.map(e => colliderBlockDefinition(v, e) as any);
      const names = ENCODINGS.map(e => kit.stateNames(e));
      for (let lo = 0; lo < 16; lo++) for (let hi = lo + 1; hi <= 16; hi++) {
        const a = boxesFor(legacy, kit.encodeStates(names[0]!.lo, names[0]!.hi, lo, hi));
        const b = boxesFor(pair, kit.encodeStates(names[1]!.lo, names[1]!.hi, lo, hi));
        expect(b, `${COLLIDER_KIT.VARIANTS[v]!.id} [${lo},${hi}]`).toEqual(a);
      }
    }
  });

  it('the compact encoding round-trips all 136 (lo, hi) pairs and declares at most 16 values per state', () => {
    const kit = colliderFormKit();
    const { lo: loName, hi: hiName } = kit.stateNames('pair');
    const def = colliderBlockDefinition(0, 'pair') as any;
    const declared = def['minecraft:block'].description.states as Record<string, { values: { min: number; max: number } }>;
    expect(Object.keys(declared).sort()).toEqual([loName, hiName].sort());
    let product = 1;
    for (const s of Object.values(declared)) { const n = s.values.max - s.values.min + 1; expect(n).toBeLessThanOrEqual(16); product *= n; }
    expect(product).toBeLessThanOrEqual(232); // 43 ids x 232 stays under 10,000 with room for the brick blocks
    expect(def['minecraft:block'].permutations.length).toBe(136);
    const seen = new Set<string>();
    for (let lo = 0; lo < 16; lo++) for (let hi = lo + 1; hi <= 16; hi++) {
      const states = kit.encodeStates(loName, hiName, lo, hi);
      for (const [k, v] of Object.entries(states)) { const d = declared[k]!.values; expect(v >= d.min && v <= d.max, `${k}=${v}`).toBe(true); }
      expect(kit.decodeStates(loName, states[loName]!, states[hiName]!)).toEqual([lo, hi]);
      seen.add(`${states[loName]},${states[hiName]}`);
    }
    expect(seen.size).toBe(136);
    // the legacy spelling is the identity
    expect(kit.encodeStates('craftmatic:lo', 'craftmatic:hi', 3, 9)).toEqual({ 'craftmatic:lo': 3, 'craftmatic:hi': 9 });
    expect(kit.decodeStates('craftmatic:lo', 3, 9)).toEqual([3, 9]);
  });

  it('lay writes a form under the encoding its state names say, and the wall + floor fallback does too', () => {
    const kit = colliderFormKit();
    for (const e of ENCODINGS) {
      const { lo, hi } = kit.stateNames(e);
      const laid: Array<{ id: string; states: Record<string, number> }> = [];
      const block = { setPermutation: (p: unknown) => { laid.push(p as never); } };
      expect(kit.lay(block, { v: 0, lo: 2, hi: 11 }, lo, hi, (id, states) => ({ id, states }))).toBe(true);
      expect(laid[0]).toEqual({ id: 'craftmatic:collider', states: kit.encodeStates(lo, hi, 2, 11) });
      // a world that does not know the form id: the full collider over the form's vertical extent
      let calls = 0;
      const fell = kit.lay(block, { v: 3, lo: 2, hi: 11 }, lo, hi, (id, states) => { if (calls++ === 0) throw new Error('unknown'); return { id, states }; });
      expect(fell).toBe(false);
      expect(laid[1]!.id).toBe('craftmatic:collider');
    }
  });
});
