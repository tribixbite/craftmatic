/**
 * The generality census's doorway findings (gate `output/gengate-6fa0afa6/`, 2026-11-16, IX-05): two recon_v3
 * brick-tub reconstructions whose doorway lines the simulator judged wrongly. Run on the census's own packs, which
 * live only on the machine that built them, so the suite skips where they are missing (CI).
 *
 *   - 5482 stacks its four doors in one column (Door 1 under Door 2 under Door 3 ...). The doorway step left each
 *     door OPEN after walking its lines, so Door 2's lines were walked with Door 1 - the floor under them - swung
 *     away, and fell 5.4 blocks through it at 200 percent, blamed on the pack.
 *   - 6164's Door 1 hangs 2.3 blocks over the ground at 400 percent with nothing drawn in front of it. Its porch
 *     lines start in the air, fall to the ground and walk into the tread under the doorway; the stop was blamed on the
 *     tread, though the line had already lost the doorway's level where the model draws no floor.
 *   - At 400 percent 5482's Door 3 shares grid cells with Door 2: its lines stop on Door 2's shut leaf, which the
 *     simulator drew at 100 percent (a moving part's size is its `ix_root` bone's animated scale, not
 *     `minecraft:scale`) and so read as "nothing is drawn there".
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readAddon, type Addon } from '../web/src/sim/pack/pack.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';
import { readCraftmaticPack, type CraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { CRAFTMATIC_ALLOWED_LINES } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { entityDrawn, packAppearance } from '../web/src/sim/adapters/craftmatic/drawn.js';
import { ixKeys } from '../web/src/sim/adapters/craftmatic/namespace.js';

const GATE = 'C:/git/craftmatic/output/gengate-6fa0afa6';
const PACK_5482 = `${GATE}/5482-ultimate-house-building-set.mcaddon`;
const PACK_6164 = `${GATE}/6164-rescue-building-set.mcaddon`;
const havePacks = existsSync(PACK_5482) && existsSync(PACK_6164);

async function load(path: string): Promise<{ addon: Addon; pack: CraftmaticPack }> {
  const b = readFileSync(path);
  const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, path);
  return { addon, pack: readCraftmaticPack(addon)! };
}

const doorIndex = (pack: CraftmaticPack, label: string): number => pack.interactives?.items.findIndex(it => it.label === label) ?? -1;

describe.skipIf(!havePacks)('census doorway lines (gengate-6fa0afa6, IX-05)', () => {
  it('walks each door of a stack with the doors under it at rest (5482 Doors 1-3 at 200 percent)', async () => {
    const { addon, pack } = await load(PACK_5482);
    const only = ['Door 1', 'Door 2', 'Door 3'].map(l => doorIndex(pack, l));
    const r = await runScenario({ name: 'stack-200', allowLines: [...CRAFTMATIC_ALLOWED_LINES], steps: [{ kind: 'place', size: 200, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'doorwayLines', only }] }, [addon], { handlers: craftmaticHandlers(pack, addon) });
    const holes = r.violations.filter(v => v.invariant === 'doorway-line' && /^Door [23] .*HOLE/.test(v.message));
    expect(holes.map(v => v.message)).toEqual([]);
  }, 120_000);

  it('judges a line that fell off the doorway\'s level before reaching it by that fall, not by the tread it then met (6164 Door 1 at 400 percent)', async () => {
    const { addon, pack } = await load(PACK_6164);
    const r = await runScenario({ name: 'porch-400', allowLines: [...CRAFTMATIC_ALLOWED_LINES], steps: [{ kind: 'place', size: 400, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'doorwayLines', only: [doorIndex(pack, 'Door 1')] }] }, [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.violations.filter(v => v.invariant === 'doorway-line').map(v => v.message)).toEqual([]);
    // The porch lines are still reported: as the model's drop, with where the feet left the doorway's level.
    expect(r.notes.some(n => /Door 1 column .*porch.*lost the doorway's level.*the MODEL's/.test(n))).toBe(true);
  }, 120_000);

  it('draws a moving part at its wand size: a 400 percent door is four times its 100 percent leaf (5482 Door 2)', async () => {
    const { addon, pack } = await load(PACK_5482);
    const appearance = packAppearance(addon);
    let heights: number[] = [];
    await runScenario({ name: 'drawn-400', allowLines: [/.*/], steps: [{ kind: 'place', size: 400, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'expect', label: 'h', check: async ctx => {
      const door = [...ctx.sim.engine.entities.values()].find(e => e.dynamic.get(ixKeys(pack.namespace).index) === doorIndex(pack, 'Door 2'))!;
      const d = entityDrawn(appearance, door) ?? [];
      heights = [Math.max(...d.map(b => b.box.y1)) - Math.min(...d.map(b => b.box.y0))];
      return undefined;
    } }] }, [addon], { handlers: craftmaticHandlers(pack, addon) });
    // The leaf is 2.0 blocks tall at 100 percent (4131, "Door 2 x 4 x 5"): 8 at 400.
    expect(heights[0]).toBeGreaterThan(7.5);
  }, 120_000);

  it('calls a stop on another door\'s shut leaf in a shared doorway the model\'s (5482 Door 3 over Door 2 at 400 percent)', async () => {
    const { addon, pack } = await load(PACK_5482);
    const r = await runScenario({ name: 'overlap-400', allowLines: [...CRAFTMATIC_ALLOWED_LINES], steps: [{ kind: 'place', size: 400, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'doorwayLines', only: [doorIndex(pack, 'Door 3')] }] }, [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.violations.filter(v => v.invariant === 'doorway-line' && /nothing is drawn there/.test(v.message)).map(v => v.message)).toEqual([]);
    expect(r.notes.some(n => /Door 3 column .*another door's shut leaf holds that cell of this doorway \(OVERLAP\)/.test(n))).toBe(true);
  }, 120_000);
});

/**
 * The second census (gate `output/gengate2-cda5f7b9/`): a stack's unchosen doors are held shut by the export
 * (`fixed`, playable-addon.ts `chooseStackedDoors`) and their leaves' boxes become static colliders, laid whole-cell.
 * Built by this branch into `output/gen2gate-v2/` (local only, skipped where missing).
 */
const PACK_5482_V2 = 'output/gen2gate-v2/5482-ultimate-house-building-set.mcaddon';
describe.skipIf(!existsSync(PACK_5482_V2))('census doorway lines next to doors held shut (gen2gate-v2, IX-05)', () => {
  it('calls a stop on a held-shut door\'s static leaf cells the model\'s (5482 Door 2 at 200 percent, Doors 1, 3, 4 shut)', async () => {
    const { addon, pack } = await load(PACK_5482_V2);
    expect(pack.interactives?.items.filter(it => it.fixed).length).toBe(3);
    const r = await runScenario({ name: 'held-200', allowLines: [...CRAFTMATIC_ALLOWED_LINES], steps: [{ kind: 'place', size: 200, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'doorwayLines', only: [doorIndex(pack, 'Door 2')] }] }, [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.violations.filter(v => v.invariant === 'doorway-line').map(v => v.message)).toEqual([]);
    expect(r.notes.some(n => /Door 2 column .*OVERLAP/.test(n))).toBe(true);
  }, 120_000);
});
