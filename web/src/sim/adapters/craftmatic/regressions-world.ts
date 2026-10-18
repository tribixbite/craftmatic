/**
 * Regression cases of the simulator's WORLD (package D, 2026-10-08): device
 * findings that needed water to reproduce. Appended to `REGRESSIONS`
 * (regressions.ts) and judged by the same verdict rules.
 */

import type { RegressionCase } from './regressions.js';
import { scriptedVehicleTypes } from './vehicle-course.js';
import type { CraftmaticPack } from './pack-facts.js';

/** The repository's output folder (where the device rounds' packs are kept). */
const ROUND = 'C:/git/craftmatic/output';

/** The pack's boat type (the case needs one). */
function boatType(pack: CraftmaticPack): string {
  const t = scriptedVehicleTypes(pack).find(x => x.mode === 'boat');
  if (!t) throw new Error('the pack has no scripted boat');
  return t.typeId;
}

/** What `boatFloat` recorded. */
interface BoatFloat { depth: number; draft: number; origin: number; drawnBottom: number | null; drove: number; offLevel: number }

export const WORLD_REGRESSIONS: RegressionCase[] = [
  {
    id: 'ship-floats-29b', title: '10365 pirate ship floats about three blocks OVER the water: the runtime held its origin a draft under the surface, but the drawn hull hung above it (VEH-09)',
    evidence: 'Saga probe 2026-09-28 (`output/probe-0928-float/`, `saga/ContentLog-probe.txt` CMVT y -61.3 = surface -60.1 - draft 1.2; the lowest DRAWN point +2.86 over the origin), round 2026-09-28a build `ed25bf51`; fixed offline (drawn vertical bounds, the keel draft, the waterline scan) and confirmed on Pixel+Saga round 29b (TASKS-BEDROCK-ADDON.md: "floats 5.3 below the surface on both phones, waterline above the hull\'s bottom edge, lower hull and posts under water, drives 43 blocks level")',
    oldPack: `${ROUND}/device-round-2026-09-28a/packs-ed25bf51/10365-captain-jack-sparrows-pirate-ship.mcaddon`, newStem: '10365-captain-jack-sparrows-pirate-ship', expectNew: 'pass',
    // A pool two blocks deeper than the draft (29b used 7 for a 5.23 draft), the hull at rest, then 3 s of stick forward.
    scenario: pack => ({ name: 'ship-floats-29b', steps: [{ kind: 'boatFloat', type: boatType(pack) }], allowLines: [/CAR|HOVER|FLY|PLANE|BOAT|mph|Hotbar slot 9|knots/i] }),
    // The fault: the drawn hull's lowest point over the water's surface. The fix must also still drive level (29b: 43 blocks).
    judge: r => {
      const f = r.state['boatFloat'] as BoatFloat | undefined;
      if (!f || f.drawnBottom === null) return { reproduced: false, evidence: 'no drawn hull measured', untested: 'the boat\'s drawn geometry was not found' };
      const evidence = `draft ${f.draft} in a ${f.depth}-deep pool: origin ${f.origin} from the surface, drawn bottom ${f.drawnBottom} from it; drove ${f.drove} blocks in 3 s, ${f.offLevel} off level`;
      return { reproduced: f.drawnBottom > 0 || f.drove < 10 || f.offLevel > 0.3, evidence };
    },
  },
];
