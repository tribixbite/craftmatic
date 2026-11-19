/**
 * The third census sample's vehicle finding (gate `output/gengate-d622026b/`, 2026-11-19, VEH-20): 60086's helicopter,
 * a native ROTORCRAFT carrying parts since gen-veh2. At 400 percent the child opened its canopy from the far end of
 * the hull, 13 blocks from the root, and held there to board: a native vehicle has no board points, so the device's
 * interact - refused past ~12 blocks of the root (quirk `interact-root-reach`) - did not mount it, and the step blamed
 * the open part. Run on the census's own pack, which lives only on the machine that built it (skipped elsewhere).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { craftmaticHandlers, CRAFTMATIC_ALLOWED_LINES } from '../web/src/sim/adapters/craftmatic/child-play.js';

const PACK_60086 = 'C:/git/craftmatic/output/gengate-d622026b/60086-city-starter-set.mcaddon';

describe.skipIf(!existsSync(PACK_60086))('census vehicle parts (gengate-d622026b, VEH-20)', () => {
  it('boards a big native rotorcraft with a part open from within its root\'s reach (60086 at 400 percent)', async () => {
    const b = readFileSync(PACK_60086);
    const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, PACK_60086);
    const pack = readCraftmaticPack(addon)!;
    const r = await runScenario({ name: 'heli-400', allowLines: [...CRAFTMATIC_ALLOWED_LINES], steps: [{ kind: 'place', size: 400, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'vehicleParts', type: 'craftmatic:citystarter_60086_helicopter_1' }] }, [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.violations.filter(v => v.invariant === 'tap-boards-ride').map(v => v.message)).toEqual([]);
    expect(r.notes.some(n => /past the hold's reach of a native vehicle's root .*walked in/.test(n))).toBe(true);
  }, 120_000);
});
