/**
 * The REGRESSION SET: device bugs found on the phones on 2026-09-29, each a
 * named scenario with its evidence, run on the pack the device ran (it must
 * reproduce) and on a pack built from the current tree (it must pass - or,
 * where the fault is the MODEL's geometry, reproduce and be attributed to the
 * model). A case the simulator cannot reproduce says which engine behaviour is
 * missing; the scenarios are never tuned to the answer.
 */

import type { Scenario, Step } from '../../scenario/types.js';
import type { ScenarioResult } from '../../scenario/runner.js';
import type { CraftmaticPack } from './pack-facts.js';
import { CRAFTMATIC_ALLOWED_LINES } from './child-play.js';
import { doorwayFindings } from './play.js';

/** What the current tree's pack should do. */
export type Expectation = 'pass' | 'reproduce-as-model';

/** One regression case. */
export interface RegressionCase {
  id: string;
  title: string;
  /** Where the device saw it (round folder, tracker section, commit). */
  evidence: string;
  /** The pack the device ran, absolute path. */
  oldPack: string;
  /** The stem of the current tree's pack (`<dir>/<stem>.mcaddon`). */
  newStem: string;
  expectNew: Expectation;
  scenario(pack: CraftmaticPack): Scenario;
  /** Whether a result shows the fault, with the evidence line. */
  judge(result: ScenarioResult, pack: CraftmaticPack): { reproduced: boolean; attribution?: 'model' | 'pack'; evidence: string };
  /** Why the simulator cannot reproduce it, when that is known up front (a missing engine behaviour). */
  limits?: string;
}

const ROUND = 'C:/git/craftmatic/output';
const allow = [...CRAFTMATIC_ALLOWED_LINES];
const place: Step[] = [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }];
const rideIndex = (pack: CraftmaticPack, kind: string): number => pack.rides?.rides.find(r => r.kind === kind)?.index ?? -1;
const doorIndex = (pack: CraftmaticPack, label: string): number => pack.interactives?.items.findIndex(it => it.label === label) ?? -1;
const violated = (r: ScenarioResult, invariant: string, text?: RegExp): string | undefined => {
  const v = r.violations.find(x => x.invariant === invariant && (!text || text.test(x.message)));
  return v ? `${v.invariant}: ${v.message}` : undefined;
};

/** The 2026-09-29 regression set. */
export const REGRESSIONS: RegressionCase[] = [
  {
    id: 'gabby-slide-on-rails', title: '10788 slide: the rider rides on the side rails, 30 LDU over the bed',
    evidence: 'TASKS-BEDROCK-ADDON.md "User report 2026-09-29" (round 29b); add-on guide "The user\'s report and the play round"; fix 377850a5',
    oldPack: `${ROUND}/device-round-2026-09-29b/packs-f37227ad/10788-gabbys-dollhouse.mcaddon`, newStem: '10788-gabbys-dollhouse', expectNew: 'pass',
    // 29b's rides.js boards only by the vanilla interact (the device used /ride): a hold.
    scenario: pack => ({ name: 'gabby-slide-on-rails', steps: [...place, { kind: 'rideSlide', index: rideIndex(pack, 'slide'), board: 'hold' }], allowLines: allow }),
    judge: r => { const v = violated(r, 'slide-rides-in-chute'); return { reproduced: !!v, evidence: v ?? (r.notes.find(n => /over the drawn chute/.test(n)) ?? 'no slide note') }; },
  },
  {
    id: 'gabby-lift-cap', title: '10788 lift: the "car" is the shaft\'s back-wall cap and never carries the rider past the floors',
    evidence: 'TASKS-BEDROCK-ADDON.md "User report 2026-09-29"; add-on guide "The lift\'s car was the wrong assembly" (stops a third of a block low); rec/lift10788_a-big-1-8.jpg; fix 377850a5',
    oldPack: `${ROUND}/device-round-2026-09-29b/packs-f37227ad/10788-gabbys-dollhouse.mcaddon`, newStem: '10788-gabbys-dollhouse', expectNew: 'pass',
    scenario: pack => ({ name: 'gabby-lift-cap', steps: [...place, { kind: 'rideLift', index: rideIndex(pack, 'lift'), trips: 3, board: 'hold', on: 'seat' }], allowLines: allow }),
    // Set down inside the floor (the device's "stops a third of a block low") shows as the player
    // left inside a collider. Until the x mirror of block collision boxes was measured (quirk
    // block-collision-x-mirrored, 2026-09-30) the simulator read the old pack's ceiling forms on the
    // wrong half and saw a 1.71-block drop instead; read as the device reads them, the set-down is
    // inside `collider_c2` / `collider_w2` on every trip and the drop is under a block.
    judge: r => { const v = violated(r, 'rider-set-down') ?? violated(r, 'lift-car-in-model') ?? violated(r, 'tap-boards-ride') ?? violated(r, 'player-not-in-solid'); return { reproduced: !!v, evidence: v ?? r.notes.filter(n => /lift/.test(n)).join(' / ') }; },
  },
  {
    id: 'gabby-car-overhang', title: '10797 car driven under an overhang falls through the world (Saga: y -104)',
    evidence: 'TASKS-BEDROCK-ADDON.md "User report 2026-09-29"; `output/gabby-play-0929/saga/s43-s46` (worktree agent-a743597866bba6650); host test "drives a low car under an overhang" (377850a5)',
    oldPack: `${ROUND}/device-round-2026-09-29b/packs-f37227ad/10797-gabbys-party-room.mcaddon`, newStem: '10797-gabbys-party-room', expectNew: 'pass',
    scenario: pack => ({ name: 'gabby-car-overhang', steps: [...place, { kind: 'driveVehicle', type: pack.vehicleTypes[0] ?? '-', ticks: 400 }, { kind: 'driveUnderFixture', type: pack.vehicleTypes[0] ?? '-' }], allowLines: allow }),
    judge: r => { const v = violated(r, 'nothing-below-ground'); return { reproduced: !!v, evidence: v ?? r.notes.filter(n => /overhang|fixture|drove/.test(n)).slice(-2).join(' / ') }; },
    limits: 'where the Saga\'s car met its overhang is not recorded; the course drives under the model\'s own overhangs and under a fixture with the host test\'s geometry',
  },
  {
    id: 'gabby-car-eye', title: '10797 car: the driver\'s eye is inside the bodywork (0 of 15 forward rays clear)',
    evidence: 'add-on guide "A doll car\'s guessed seat put the eye in its bodywork" (Saga 29b, `forwardView`); fix 377850a5',
    oldPack: `${ROUND}/device-round-2026-09-29b/packs-f37227ad/10797-gabbys-party-room.mcaddon`, newStem: '10797-gabbys-party-room', expectNew: 'pass',
    scenario: pack => ({ name: 'gabby-car-eye', steps: [...place, { kind: 'driveVehicle', type: pack.vehicleTypes[0] ?? '-', ticks: 100 }], allowLines: allow }),
    judge: r => { const v = violated(r, 'driver-sees-ahead'); return { reproduced: !!v, evidence: v ?? (r.notes.find(n => /horizon ahead/.test(n)) ?? 'the driver sees the horizon ahead') }; },
  },
  {
    id: 'cockpit-occluded-42639', title: '42639 car: the cockpit view (hotbar 9) is two thirds the car\'s own teal body',
    evidence: 'TASKS-BEDROCK-ADDON.md round 30f; `output/device-round-2026-09-30f/pixel/47b-47e` + `_notes.txt` "2 DRIVER VIEWS"; add-on guide "The driver\'s eye sees the road ahead"; fix 9759f0bf',
    oldPack: `${ROUND}/device-round-2026-09-30f/packs-dc699e3e/42639-andreas-modern-mansion.mcaddon`, newStem: '42639-andreas-modern-mansion', expectNew: 'pass',
    scenario: pack => ({ name: 'cockpit-occluded-42639', steps: [...place, { kind: 'driveVehicle', type: pack.vehicleTypes[0] ?? '-', ticks: 100 }], allowLines: allow }),
    judge: r => { const v = violated(r, 'driver-sees-ahead'); return { reproduced: !!v, evidence: v ?? (r.notes.find(n => /horizon ahead/.test(n)) ?? 'the driver sees the horizon ahead') }; },
  },
  {
    id: 'cockpit-side-panel-42639', title: '42639 car (30g): road and horizon visible, but a teal side panel covers the left ~35 % of the cockpit view',
    evidence: 'TASKS-BEDROCK-ADDON.md round 30g; `output/device-round-2026-09-30g/saga/s70-42639-cockpit.jpg` + `_notes.txt` "COCKPIT VIEWS"; add-on guide "The view to either side"',
    oldPack: `${ROUND}/device-round-2026-09-30g/packs-c73c545a/42639-andreas-modern-mansion.mcaddon`, newStem: '42639-andreas-modern-mansion', expectNew: 'pass',
    scenario: pack => ({ name: 'cockpit-side-panel-42639', steps: [...place, { kind: 'driveVehicle', type: pack.vehicleTypes[0] ?? '-', ticks: 100 }], allowLines: allow }),
    judge: r => { const v = violated(r, 'driver-sees-ahead'); return { reproduced: !!v, evidence: v ?? (r.notes.find(n => /horizon ahead/.test(n)) ?? 'the driver sees out') }; },
  },
  {
    id: 'cockpit-in-hull-76286', title: '76286 Milano (30g): the cockpit view is the inside of the hull, no horizon',
    evidence: 'TASKS-BEDROCK-ADDON.md round 30g; `output/device-round-2026-09-30g/saga/s74-76286-cockpit.jpg` + `_notes.txt` "COCKPIT VIEWS"; add-on guide "When no eye in the cabin sees ahead"',
    oldPack: `${ROUND}/device-round-2026-09-30g/packs-c73c545a/76286-the-milano-spaceship.mcaddon`, newStem: '76286-the-milano-spaceship', expectNew: 'pass',
    scenario: pack => ({ name: 'cockpit-in-hull-76286', steps: [...place, { kind: 'driveVehicle', type: pack.vehicleTypes[0] ?? '-', ticks: 100 }], allowLines: allow }),
    judge: r => { const v = violated(r, 'driver-sees-ahead'); return { reproduced: !!v, evidence: v ?? (r.notes.find(n => /horizon ahead/.test(n)) ?? 'the driver sees out') }; },
  },
  {
    id: 'gabby-slide-tap', title: '10788 slide (29c): a tap on the slide\'s seat boards nothing',
    evidence: 'TASKS-BEDROCK-ADDON.md "Round 2026-09-29c" (Pixel, three taps); add-on guide "The slide\'s seat could not be boarded by a tap"; fix 16d4bc82',
    oldPack: `${ROUND}/device-round-2026-09-29c/packs-e2c21112/10788-gabbys-dollhouse.mcaddon`, newStem: '10788-gabbys-dollhouse', expectNew: 'pass',
    scenario: pack => ({ name: 'gabby-slide-tap', steps: [...place, { kind: 'rideSlide', index: rideIndex(pack, 'slide'), board: 'tap' }], allowLines: allow }),
    judge: r => { const v = violated(r, 'tap-boards-ride'); return { reproduced: !!v, evidence: v ?? (r.notes.find(n => /slide/.test(n)) ?? 'boarded') }; },
  },
  {
    id: 'nimbus-sneak-fall', title: 'Nimbus: sneaking off the cloud at altitude drops the player to the ground',
    evidence: 'TASKS-BEDROCK-ADDON.md "New-set onboarding + 11390" (Saga: 229 blocks from ALT 169); physics spec §4.6; fix a754a7de',
    oldPack: `${ROUND}/nimbus-main-0929/nimbus-fixture.mcaddon`, newStem: 'nimbus-fixture', expectNew: 'pass',
    scenario: () => ({ name: 'nimbus-sneak-fall', steps: [...place, { kind: 'flyMount', climbTicks: 60, flyTicks: 40 }], allowLines: allow }),
    judge: r => { const v = violated(r, 'no-unprotected-fall'); return { reproduced: !!v, evidence: v ?? 'landed under slow falling' }; },
  },
  {
    id: 'nimbus-hint-overwritten', title: 'Nimbus: the summon\'s action-bar hint is overwritten by the driver HUD within 4 ticks',
    evidence: 'TASKS-BEDROCK-ADDON.md "New-set onboarding + 11390" (fix a754a7de: the ride hint for the first 60 ticks); CLAUDE.md scope note (vehicle-driver.js overwrote flyer.js)',
    oldPack: `${ROUND}/nimbus-main-0929/nimbus-fixture.mcaddon`, newStem: 'nimbus-fixture', expectNew: 'pass',
    scenario: () => ({ name: 'nimbus-hint-overwritten', steps: [...place, { kind: 'flyMount', climbTicks: 20, flyTicks: 10 }], allowLines: allow }),
    judge: r => { const v = violated(r, 'actionbar-not-stolen', /replaced scripts\/flyer\.js's/); return { reproduced: !!v, evidence: v ?? 'the hint stood at least a second' }; },
  },
  {
    id: 'door1-10326', title: '10326 Door 1: walking in from the porch drops the player 2.25 blocks at the door plane',
    evidence: 'TASKS-BEDROCK-ADDON.md "Round 2026-09-29c" defect (A) (Saga: ends at y -59.75); docs/bedrock-interactivity.md "The doorway\'s floor, a floor\'s top, and the device\'s line" (the model\'s: the door hangs 2.6 over the plate, the porch was a teleport into the air); merge c4c34b1c',
    oldPack: `${ROUND}/device-round-2026-09-29d/packs-3abc14f7/10326-natural-history-museum.mcaddon`, newStem: '10326-natural-history-museum',
    // The user kept the invisible 1-block ledge at the doorway's level (2026-09-30:
    // "always prefer unlocking exploration and interactivity"). On the round's source
    // (IOModel2V2 10326-noprint.ldr, what the device runs) the doorway's own lines pass,
    // but the porch line still drops 2.625: the door hangs 2.6 over the base plate with
    // nothing drawn in front (the model's). The `.io` source reads no HOLE at all.
    // Since the access steps (2026-09-30, docs/bedrock-interactivity.md "Access steps")
    // the grid is widened 6 blocks in front of the museum and an invisible half-block
    // stair runs straight out of each leaf column down to the ground: the porch line
    // starts on it and walks in.
    expectNew: 'pass',
    scenario: pack => ({ name: 'door1-10326', steps: [...place, { kind: 'doorwayLines', only: [doorIndex(pack, 'Door 1')] }], allowLines: allow }),
    judge: r => doorJudge(r, 'Door 1', 'HOLE'),
  },
  {
    id: 'door3-910004', title: '910004 Door 3: walking out stops one cell before the doorway on a collider at head height',
    evidence: 'TASKS-BEDROCK-ADDON.md "Round 2026-09-29c" defect (B) (collider_w6 at head height in the approach cell); docs/bedrock-interactivity.md (the model\'s: 1.25-1.75 blocks of headroom inside); merge c4c34b1c',
    oldPack: `${ROUND}/device-round-2026-09-29d/packs-3abc14f7/910004-winter-chalet.mcaddon`, newStem: '910004-winter-chalet', expectNew: 'reproduce-as-model',
    scenario: pack => ({ name: 'door3-910004', steps: [...place, { kind: 'doorwayLines', only: [doorIndex(pack, 'Door 3')] }], allowLines: allow }),
    judge: r => doorJudge(r, 'Door 3', 'STOP'),
  },
  {
    id: 'retake-no-seat-10261', title: '10261: a spurious FIGURE_RETAKE_NO_SEAT during the placement, before the seats exist',
    evidence: 'TASKS-BEDROCK-ADDON.md "Round 2026-09-29c" defect (D); fix db994f40 (seated figures wait for the placement\'s seating pass, `craftmatic:fig_seating`)',
    oldPack: `${ROUND}/device-round-2026-09-29d/packs-3abc14f7/10261-roller-coaster.mcaddon`, newStem: '10261-roller-coaster', expectNew: 'pass',
    scenario: () => ({ name: 'retake-no-seat-10261', steps: [...place, { kind: 'figuresLive', ticks: 3000 }], allowLines: allow }),
    judge: r => { const v = violated(r, 'no-unexpected-line', /FIGURE_RETAKE_NO_SEAT/); return { reproduced: !!v, evidence: v ?? 'no FIGURE_RETAKE_NO_SEAT line' }; },
  },
];

/** A doorway case: reproduced when the door's device lines found the fault kind; attributed as the lines said. */
function doorJudge(r: ScenarioResult, label: string, kind: 'HOLE' | 'STOP'): { reproduced: boolean; attribution?: 'model' | 'pack'; evidence: string } {
  const findings = (r.state ? doorwayFindings(r.state) : []).filter(f => f.where.startsWith(`${label} `) && f.kind === kind);
  if (!findings.length) return { reproduced: false, evidence: `no ${kind} on ${label}'s lines` };
  const model = findings.every(f => f.model);
  return { reproduced: true, attribution: model ? 'model' : 'pack', evidence: findings.map(f => `${f.where}: ${f.kind}${typeof f['drop'] === 'number' ? ` ${f['drop']} down` : ''} (${f.model ? 'the model\'s' : 'the pack\'s'})`).join('; ') };
}
