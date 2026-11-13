/**
 * T02-fix (BIZ-26, BIZ-27): the four findings of the store-review simulator scenario, each pinned by the scenario itself.
 *
 *   1. player-facing text said "minifig" (the walk-through note) and an Interaction-scale note began "Minecraft only ...";
 *   2. M03's own brick blocks shipped but a coloured-block placement still wrote vanilla concrete;
 *   3. "Find a clear spot" could choose a footprint covering the player (`player-not-in-solid` inside a collider);
 *   4. Undo left a scripted vehicle's boarding points standing (two `<stem>_board_100` on the batcave car).
 *
 * The nimbus stand-in runs everywhere (seeded parts); the batcave car needs the real Studio library and is skipped without it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXED_STAMP, buildNimbusPack } from './pack-profile-support.js';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { PackProfile } from '../web/src/engine/pack-profile.js';
import { INTERACTIVE_REACH_NOTE } from '../web/src/engine/bedrock-interactives.js';
import { brickBlockPalette } from '../web/src/engine/marketplace/blocks.js';
import { lintText } from '../web/src/engine/pack-text/lint.js';
import { runMarketplace } from '../web/src/sim/adapters/craftmatic/marketplace.js';
import type { ScenarioResult } from '../web/src/sim/scenario/runner.js';

/** The X-02 store flags (what a release profile sets). */
const STORE: PackProfile = { flags: { vanillaTextures: false, diagnostics: false, devStamp: false, marketplacePlacement: true, brickBlocks: true, compactColliderStates: true, explicitOnly: true } };
/** A label with no set number or licensed word, so the lint reports only what the pack's own wording says. */
const LABEL = 'Brick Flyer';

const violations = (results: ScenarioResult[], invariant: string): string[] =>
  results.flatMap(r => r.violations.filter(v => v.invariant === invariant).map(v => `${r.name}: ${v.message}`));

describe('sim-marketplace-fix', () => {
  it('player-facing text names no minifig and starts no sentence with "Minecraft" (finding 1)', async () => {
    const { results } = await runMarketplace(await buildNimbusPack(STORE, LABEL), { source: 'store', quick: true });
    const words = violations(results, 'player-text-lint').filter(m => /minifig|Minecraft/i.test(m));
    expect(words).toEqual([]);
  }, 300_000);

  it('the Interaction-scale note passes the player-text lint (finding 1)', () => {
    expect(lintText(INTERACTIVE_REACH_NOTE, { surface: 'prose' }).map(f => `${f.ruleId}: ${f.match}`)).toEqual([]);
  });

  it('brickBlockPalette respells the swatch concretes as the pack brick blocks and keeps every other entry (finding 2)', () => {
    const palette = ['minecraft:air', 'minecraft:red_concrete', 'minecraft:light_gray_concrete', 'minecraft:stone', 'minecraft:cyan_concrete_powder', 'craftmatic:collider[lo=0,hi=16]'];
    expect(brickBlockPalette(palette, 'craftmatic')).toEqual(['minecraft:air', 'craftmatic:brick_red', 'craftmatic:brick_light_gray', 'minecraft:stone', 'minecraft:cyan_concrete_powder', 'craftmatic:collider[lo=0,hi=16]']);
  });

  it('a coloured-block placement writes the pack\'s own brick blocks, not vanilla concrete (finding 2)', async () => {
    const pack = await buildNimbusPack(STORE, LABEL, { buildingFidelity: 'blocks' });
    const { results } = await runMarketplace(pack, { source: 'store', quick: true });
    expect(violations(results, 'brick-blocks-unused')).toEqual([]);
    const note = results.flatMap(r => r.notes).find(n => /placed blocks:/.test(n));
    expect(note, 'the scenario notes what the placement wrote').toBeDefined();
    expect(note).toMatch(/[1-9]\d* brick\/plate/);
    expect(note).toMatch(/0 vanilla concrete/);
  }, 300_000);

  it('Find a clear spot never chooses a footprint that covers the player (finding 3)', async () => {
    const pack = await buildNimbusPack(STORE, LABEL, { buildingFidelity: 'blocks' });
    const { results } = await runMarketplace(pack, { source: 'store', quick: true });
    expect(violations(results, 'player-not-in-solid')).toEqual([]);
  }, 300_000);

  const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
  it.skipIf(!existsSync(LDRAW_ROOT))('Undo removes a vehicle\'s boarding points with the placement (finding 4)', async () => {
    setLDrawRoot(LDRAW_ROOT);
    const doc = parseLDrawDocument(readFileSync('test/fixtures/batcave-car-assembly.ldr', 'utf8'));
    const built = await runSchemPipeline({
      source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
      format: 'mcaddon', packStem: 'Batcave', packLabel: 'Brick Car', profile: 'default', lightFill: false, shapes: false,
      vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1, pipelineStamp: FIXED_STAMP, sourceProvenance: null, packProfile: STORE,
    });
    const { results } = await runMarketplace(built.bytes!, { source: 'store' });
    const left = violations(results, 'nothing-left-after-undo').filter(m => /_board_/.test(m));
    expect(left).toEqual([]);
  }, 600_000);
});
