/**
 * The simulator's child answers the wand's "Someone is standing where it goes" prompt (A-06, PROC-19).
 *
 * Since the audit-place merge the wand asks before building colliders round a player (`holdsPlayer`,
 * bedrock-placement-pack.ts). The sim's `place` step cancelled every form it did not know, so a placement over the
 * child ended in "no Placed line" and the A-06 cases could not tell a refused placement from a missing one. The
 * child now picks "Find a clear spot nearby" (what the prompt offers first) and the step notes it; the model must
 * then stand clear of the child.
 *
 * Built through the REAL pipeline on box stand-in parts (`seedBoxParts`), so no library and no network are needed.
 */
import { describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { FIXED_STAMP, seedBoxParts } from './pack-profile-support.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';

const line = (color: number, x: number, y: number, z: number, part: string): string => `1 ${color} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 ${part}`;
/** A solid block of 2 x 2 bricks, 8 x 8 studs and six bricks high (about 3 x 2.7 x 3 blocks): colliders everywhere inside. */
const BLOCK = [0, 1, 2, 3, 4, 5].flatMap(k => [-60, -20, 20, 60].flatMap(x => [-60, -20, 20, 60].map(z => line(4, x, -24 * (k + 1), z, '3003.dat'))));

describe('the sim child answers the held-player prompt (A-06, PROC-19)', () => {
  it('a placement aimed at the child\'s own feet takes the prompt\'s clear spot, and the child is not inside the model', async () => {
    seedBoxParts();
    const bricks = parseLDrawDocument(BLOCK.join('\n')).bricks;
    const result = await runSchemPipeline({
      source: { kind: 'bricks', bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
      format: 'mcaddon', packStem: 'HeldDemo', packLabel: 'Held Demo', profile: 'default', lightFill: false, shapes: false,
      entityQuality: 'balanced', modelScale: 1, pipelineStamp: FIXED_STAMP, sourceProvenance: null,
    });
    const addon = await readAddon(result.bytes!, 'held-demo');
    const pack = readCraftmaticPack(addon)!;
    const r = await runScenario({ name: 'held', steps: [{ kind: 'place', size: 100, rotation: 0, distance: 0 }, { kind: 'wait', ticks: 20 }] },
      [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.steps.filter(s => !s.ok).map(s => s.error)).toEqual([]);
    expect(r.notes.some(n => /held-player prompt: Find a clear spot nearby/.test(n))).toBe(true);
    expect(r.violations.filter(v => v.invariant === 'player-not-in-solid').map(v => v.message)).toEqual([]);
  }, 240_000);
});
