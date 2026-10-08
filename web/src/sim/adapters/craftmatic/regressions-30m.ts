/**
 * Round 30m's OPEN device defects (Saga + Pixel, 2026-10-08, packs built from
 * 6a8c7121) as regression cases. Each replays the device's own situation on
 * the pack the phones ran and judges the finding the notes record; none of
 * them is fixed yet, so each case is `open` (regressions.ts `regressionVerdict`:
 * OPEN while the current pack still reproduces) or, where the simulator cannot
 * show the fault, KNOWN-UNREPRODUCED with the missing model in `limits`.
 *
 * Evidence: `output/device-round-2026-10-08m/saga/notes.md`,
 * `.../pixel/notes.md`, `.../saga/ContentLog-30m-live.txt` (CMVT rows quoted
 * per case). Appended to `REGRESSIONS`; only TYPES are imported from
 * regressions.ts (a value import would be a module cycle).
 */

import type { RegressionCase } from './regressions.js';
import type { ScenarioResult } from '../../scenario/runner.js';
import { CORE_HANDLERS } from '../../scenario/runner.js';
import type { StepContext } from '../../scenario/types.js';
import type { SimEntity } from '../../entity/entity.js';
import type { CraftmaticPack } from './pack-facts.js';
import { CRAFTMATIC_ALLOWED_LINES } from './child-play.js';
import { placedOf } from './play.js';
import { swipeMount } from './input-probe.js';
import { registeredAppearance, scriptedVehicleTypes, type ScriptedTypeFacts } from './vehicle-course.js';
import { drawnBoxes, type DrawnBox } from './drawn.js';
import { clientSnapshot } from './snapshot.js';
import { attachClient, ClientView } from '../../client/camera.js';
import { lookAt, pick } from '../../input/touch.js';
import { pickBoxes } from '../../input/ray.js';
import { teleport } from '../../script-host/facades.js';
import { quirkValue } from '../../quirks/registry.js';
import { FLAT_GROUND_Y } from '../../world/voxel-world.js';
import { PLAYER_EYE_HEIGHT } from '../../physics/body.js';
import type { Box, Vec3 } from '../../core/vec.js';
import { isShellEntityId } from '../../../engine/bedrock-building-shell.js';
import { REACH_GUARD_DROP16 } from '../../../engine/bedrock-collider-scale.js';

/** Where the device rounds' packs are kept. */
const ROUND = 'C:/git/craftmatic/output';
/** The round's packs (what both phones ran). */
const PACKS_30M = `${ROUND}/device-round-2026-10-08m/packs-6a8c7121`;
const SAGA_30M = '`output/device-round-2026-10-08m/saga/notes.md`';
const PIXEL_30M = '`output/device-round-2026-10-08m/pixel/notes.md`';
const OPEN_30M = 'round 30m, 2026-10-08';

const allow = [...CRAFTMATIC_ALLOWED_LINES];
/** The lines a driven vehicle's HUD prints (the course's own allowance). */
const vehicleAllow = [...allow, /CAR|HOVER|FLY|PLANE|BOAT|mph|Hotbar slot 9/];

const r2 = (v: number): number => Math.round(v * 100) / 100;
const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
const rel = (p: Vec3, a: Vec3): Vec3 => ({ x: r2(p.x - a.x), y: r2(p.y - a.y), z: r2(p.z - a.z) });
const violated = (r: ScenarioResult, invariant: string, text?: RegExp): string | undefined => {
  const v = r.violations.find(x => x.invariant === invariant && (!text || text.test(x.message)));
  return v ? `${v.invariant}: ${v.message}` : undefined;
};

/** The pack's scripted vehicle facts of a mode (the first), or a throw the run reports as an error. */
function vehicleOf(pack: CraftmaticPack, mode: ScriptedTypeFacts['mode']): ScriptedTypeFacts {
  const t = scriptedVehicleTypes(pack).find(x => x.mode === mode);
  if (!t) throw new Error(`the pack has no scripted ${mode}`);
  return t;
}

/** A pack's drawn appearance, registered by `craftmaticHandlers` (every regression run builds it). */
function appearanceOf(pack: CraftmaticPack): NonNullable<ReturnType<typeof registeredAppearance>> {
  const a = registeredAppearance(pack.pack);
  if (!a) throw new Error('the pack\'s appearance was not registered (craftmaticHandlers builds it)');
  return a;
}

/**
 * An entity's drawn boxes at a pose (its server pose unless given), translucent ones INCLUDED: what a body meets or a
 * camera sits in is everything drawn - the X-wing's engine glow is trans-orange and is what the Saga's child stood in
 * (`e07-side.jpg`); only a line of SIGHT passes glass (drawn.ts `forwardViewWorld`).
 */
function hullBoxes(pack: CraftmaticPack, e: SimEntity, pose?: { x: number; y: number; z: number; yaw: number; scale: number }, lod: 'near' | 'far' = 'near'): DrawnBox[] {
  const entry = appearanceOf(pack).byType.get(e.typeId);
  if (!entry) return [];
  const p = pose ?? { x: e.location.x, y: e.location.y, z: e.location.z, yaw: e.rotation.y, scale: e.scale() };
  return drawnBoxes(entry, { x: p.x, y: p.y, z: p.z }, p.yaw, p.scale, lod);
}

/** A player's body box (0.6 x 1.8) with its feet at `p`. */
const bodyBox = (p: Vec3): Box => ({ x0: p.x - 0.3, y0: p.y, z0: p.z - 0.3, x1: p.x + 0.3, y1: p.y + 1.8, z1: p.z + 0.3 });
/** The overlap depth of two boxes (the smallest axis overlap; <= 0 when apart, its negative the gap on that axis). */
function overlapDepth(a: Box, b: Box): number {
  return Math.min(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0), Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0));
}
/** The distance from a point to a box (0 inside). */
const pointBoxDistance = (p: Vec3, b: Box): number => Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1), Math.max(b.z0 - p.z, 0, p.z - b.z1));
const inside = (p: Vec3, b: Box): boolean => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1 && p.z > b.z0 && p.z < b.z1;

/**
 * Spawn a scripted vehicle on the flat world at `at` facing `yaw` (Bedrock: 0 faces +Z), sized by its own
 * `craftmatic:size_<pct>` event, and seat the child on it (the course's `board`, with the device's facing).
 */
async function boardAt(ctx: StepContext, typeId: string, at: { x: number; z: number }, yaw: number, pct: number): Promise<SimEntity> {
  ctx.quiet(['player-not-in-solid', 'nothing-below-ground']);
  const v = ctx.sim.engine.spawnEntity(typeId, 'overworld', { x: at.x, y: FLAT_GROUND_Y, z: at.z });
  v.rotation = { x: 0, y: yaw };
  await ctx.run(2);
  if (pct !== 100) v.triggerEvent(`craftmatic:size_${pct}`);
  const r = v.addRider(ctx.player, ctx.sim.engine.tick);
  if (!r.ok) throw new Error(`could not seat the child on ${typeId}: ${r.why}`);
  ctx.player.rotation = { x: 0, y: yaw };
  v.placeRiders();
  await ctx.run(4);
  return v;
}

/** One press of the dismount button (Sneak), as the device's tester pressed it. */
async function sneakOff(ctx: StepContext): Promise<void> {
  ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false, sneak: true });
  await ctx.run(1);
  ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false, sneak: false });
}

// ─── 1. Nimbus: forward flies along the body, never the look (FIG-08) ───

/** What `nimbus-steer-30m` measured. */
interface NimbusSteer { lookTurned: number; bodyTurned: number; look: number; body: number; travel: number; moved: number; offLook: number; offBody: number }

const nimbusSteer: RegressionCase = {
  id: 'nimbus-steer-30m', title: 'Nimbus (30m): after a swipe turns the view, holding forward flies along the BODY\'s heading, not where the player looks - the cloud cannot be steered (FIG-08)',
  evidence: `${SAGA_30M} item 1 (CMVT 01:17:51-54: look 107, body 0, moved dx -6.1 dz +25.7 = 13 degrees off the body, 94 off the look; 200 %: look 133, dx -6.6 dz +27, 01:22:11-14; \`frames/n02-fwd2-sheet.jpg\`): the driver's mount probe reads \`carried\` (quirk \`rider-yaw-lag\`), and with that verdict nothing turns the body`,
  oldPack: `${PACKS_30M}/nimbus-fixture.mcaddon`, newStem: 'nimbus-fixture', expectNew: 'pass', open: OPEN_30M,
  // The Saga's repro: summon, ride, wait 3 s (inside swipeMount), swipe right 400 px, then hold the stick forward 3 s.
  scenario: pack => ({
    name: 'nimbus-steer-30m', allowLines: allow, steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 },
      { kind: 'expect', label: 'swipe, then forward', check: async ctx => {
        const v = await swipeMount(ctx, pack, { dxPx: 400, ticks: 16, watchTicks: 40 });
        if (!v) return 'the cloud was not summoned';
        const body0 = v.rotation.y, look0 = ctx.player.rotation.y, start = { ...v.location };
        const d = ctx.state['dragMount'] as { lookTurned?: number; turned?: number } | undefined;
        for (let t = 0; t < 60; t++) { ctx.sim.controls.set(ctx.player.id, { forward: 1, strafe: 0, jump: false }); await ctx.run(1); }
        ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false });
        const dx = v.location.x - start.x, dz = v.location.z - start.z, moved = Math.hypot(dx, dz);
        // Bedrock yaw: 0 faces +Z, 90 faces -X, so a displacement's yaw is atan2(-dx, dz).
        const travel = Math.atan2(-dx, dz) * 180 / Math.PI;
        const out: NimbusSteer = { lookTurned: r2(d?.lookTurned ?? 0), bodyTurned: r2(d?.turned ?? 0), look: r2(look0), body: r2(body0), travel: r2(travel), moved: r2(moved), offLook: r2(Math.abs(wrap(travel - look0))), offBody: r2(Math.abs(wrap(travel - body0))) };
        ctx.state['nimbusSteer'] = out;
        ctx.note(`Nimbus forward after a swipe: the view turned ${out.lookTurned} degrees (look ${out.look}), the body ${out.bodyTurned} (heading ${out.body}); 3 s of forward moved ${out.moved} blocks along yaw ${out.travel} = ${out.offBody} degrees off the body, ${out.offLook} off the look`);
        return undefined;
      } }],
  }),
  judge: r => {
    const s = r.state['nimbusSteer'] as NimbusSteer | undefined;
    const notes = r.notes.filter(n => /Nimbus forward after a swipe/.test(n)).join('; ') || 'no steer note';
    if (!s) return { reproduced: false, evidence: notes, untested: 'the cloud was not summoned or not flown' };
    // The device's conditions: the view turned well off the body (the Saga: 108 and 114 degrees) and the cloud moved.
    if (Math.abs(wrap(s.look - s.body)) < 45) return { reproduced: false, evidence: notes, untested: `the swipe left the look only ${r2(Math.abs(wrap(s.look - s.body)))} degrees off the body (the device's: 94-120)` };
    if (s.moved < 3) return { reproduced: false, evidence: notes, untested: `forward moved the cloud only ${s.moved} blocks` };
    // The fault: forward does not fly where the player looks (45 degrees: half-way between the look and a body 90 off).
    return { reproduced: s.offLook > 45, evidence: notes };
  },
};

// ─── 2. Milano at 400 %: the chase view filled by the hull (VEH-06) ───

/** One size of `milano-chase-400-30m`. */
interface ChaseRow { pct: number; mode: string; boomBlocks: number; lod: 'full' | 'hull' | 'gone'; lodDistance?: number; coverage: number; eyeInside: boolean; nearestBlocks: number; span: { left: number; right: number }; fits: boolean }
/** The share of the picture the ship covers above which it "fills the view" (the Saga's 400 % frames: ~0.8-0.9; its 200 % chase ~540 of 1600 px wide). */
const FILLS_VIEW = 0.5;
/** The picture taken per size (small: only its coverage is read). */
const CHASE_SHOT = { width: 320, height: 144 };
/** The snapshot's vertical field of view (snapshot.ts `clientSnapshot`'s default), degrees. */
const CHASE_FOV_DEG = 70;

/**
 * Where drawn boxes reach across a picture, in normalised screen x (-1 the left edge, +1 the right): the rasteriser's
 * projection (vertical `fovDeg`, `aspect` = width / height) of every corner in front of the camera.
 */
function screenSpanX(camera: { eye: Vec3; dir: Vec3; up: Vec3 }, boxes: readonly DrawnBox[], fovDeg: number, aspect: number): { left: number; right: number } {
  const f = camera.dir, u = camera.up;
  // right = forward x up (the rasteriser's `cross(fwd, up)`).
  const rgt = { x: f.y * u.z - f.z * u.y, y: f.z * u.x - f.x * u.z, z: f.x * u.y - f.y * u.x };
  const k = 1 / Math.tan(fovDeg * Math.PI / 360) / aspect;
  let left = Infinity, right = -Infinity;
  for (const b of boxes) for (const x of [b.box.x0, b.box.x1]) for (const y of [b.box.y0, b.box.y1]) for (const z of [b.box.z0, b.box.z1]) {
    const v = { x: x - camera.eye.x, y: y - camera.eye.y, z: z - camera.eye.z };
    const depth = v.x * f.x + v.y * f.y + v.z * f.z;
    if (depth < 0.05) continue;
    const sx = (v.x * rgt.x + v.y * rgt.y + v.z * rgt.z) / depth * k;
    left = Math.min(left, sx); right = Math.max(right, sx);
  }
  return { left, right };
}

const milanoChase400: RegressionCase = {
  id: 'milano-chase-400-30m', title: '76286 Milano at 400 % (30m): grey/blue cuboids fill the chase view ("the camera sits on the hull") - the 48-block boom cannot frame the ship, whose coarse LOD hull is drawn past its 54-block switch; 50/100/200 % are fine (VEH-06)',
  evidence: `${SAGA_30M} item 3 (\`b-chase-grid.jpg\`, \`b-mil400-grid.jpg\`, \`b-mil400-later.jpg\`, 01:37:00; 50/100/200 % wingspan ~410/410/540 of 900 px): the shipped \`chase()\` boom is \`min(radius x size, CHASE_BOOM_MAX_BLOCKS 48)\` (playable-addon.ts) - capped at 200 % already, so 400 % keeps the 48-block boom while the hull doubles; the frames' coarse cuboids are the LOD hull (the camera is 58 blocks from the root, past the hull's 54-block switch, quirk \`lod-switch-camera-root\`)`,
  oldPack: `${PACKS_30M}/76286-the-milano-spaceship.mcaddon`, newStem: '76286-the-milano-spaceship', expectNew: 'pass', open: OPEN_30M,
  // The ship summoned on the flat world at each size the tester tried, the child seated, the chase camera left to
  // settle 4 s at rest; then the picture the phone shows (snapshot.ts `clientSnapshot`: the DRAWN camera, the Saga's
  // client, each actor full / LOD hull / culled by its camera-to-root distance) and where the drawn eye is.
  scenario: pack => ({
    name: 'milano-chase-400-30m', allowLines: vehicleAllow, steps: [{ kind: 'expect', label: 'chase view per size', check: async ctx => {
      const f = vehicleOf(pack, 'plane');
      const client = ClientView.of(ctx.sim.engine) ?? attachClient(ctx.sim, ctx.player, 'saga');
      const appearance = appearanceOf(pack);
      const rows: ChaseRow[] = [];
      for (const [i, pct] of [50, 100, 200, 400].entries()) {
        const v = await boardAt(ctx, f.typeId, { x: 600.5 + i * 400, z: -900.5 }, 0, pct);
        await ctx.run(80);
        const shot = clientSnapshot(ctx.sim.engine, appearance, ctx.player, client, CHASE_SHOT);
        const ship = shot.metrics.entities.find(e => e.id === v.id);
        const cam = shot.camera, dp = client.drawnPose(v);
        const lod = ship?.state ?? 'gone';
        // The drawn geometry the camera faces (the LOD hull past the switch), for the "on the hull" reading.
        const boxes = lod === 'gone' ? [] : hullBoxes(pack, v, { x: dp.x, y: dp.y, z: dp.z, yaw: dp.yaw, scale: dp.scale }, lod === 'hull' ? 'far' : 'near');
        const row: ChaseRow = {
          pct, mode: cam.mode, boomBlocks: r2(Math.hypot(cam.eye.x - dp.x, cam.eye.y - dp.y, cam.eye.z - dp.z)), lod, ...(ship?.lodDistance !== undefined ? { lodDistance: ship.lodDistance } : {}),
          coverage: r2(shot.metrics.drawnPixels / (shot.width * shot.height)), eyeInside: boxes.some(b => inside(cam.eye, b.box)), nearestBlocks: r2(boxes.reduce((m, b) => Math.min(m, pointBoxDistance(cam.eye, b.box)), Infinity)),
          span: { left: 0, right: 0 }, fits: true,
        };
        const span = screenSpanX(cam, boxes, CHASE_FOV_DEG, CHASE_SHOT.width / CHASE_SHOT.height);
        row.span = { left: r2(span.left), right: r2(span.right) };
        // The whole ship in the frame: its drawn reach inside both side edges (the Saga's 200 %: 540 of 900 px wide).
        row.fits = span.left > -1 && span.right < 1;
        rows.push(row);
        ctx.note(`Milano chase at ${pct} % (client ${client.profile.name}, ${row.mode} camera ${row.boomBlocks} blocks from the drawn root; the ship drawn ${lod === 'hull' ? `as its LOD HULL (switch ${row.lodDistance})` : lod === 'gone' ? 'NOT AT ALL (culled)' : 'in full'}): it covers ${Math.round(row.coverage * 100)} percent of the picture and spans screen x ${row.span.left}..${row.span.right} (${row.fits ? 'the whole ship in frame' : 'it does NOT fit the frame'}); the eye is ${row.eyeInside ? 'INSIDE' : 'outside'} the drawn geometry, ${row.nearestBlocks} blocks from it`);
        v.removeRider(ctx.player);
        ctx.sim.engine.removeEntity(v);
        await ctx.run(4);
      }
      ctx.state['milanoChase'] = rows;
      return undefined;
    } }],
  }),
  judge: r => {
    const rows = (r.state['milanoChase'] as ChaseRow[] | undefined) ?? [];
    const notes = r.notes.filter(n => /Milano chase at/.test(n)).join('; ') || 'no chase note';
    // The device's finding: cuboids fill the view and the whole ship cannot fit - both, or the eye in the hull.
    const fills = (x: ChaseRow): boolean => x.eyeInside || (x.coverage >= FILLS_VIEW && !x.fits);
    const big = rows.find(x => x.pct === 400);
    if (!big || big.mode === 'own') return { reproduced: false, evidence: notes, untested: 'no script chase camera was drawn at 400 %' };
    // The device's 50/100/200 % were fine: a reading that flags them too does not separate what the tester saw.
    const controls = rows.filter(x => x.pct < 400 && fills(x));
    if (controls.length) return { reproduced: false, evidence: notes, untested: `the fill reading also flags ${controls.map(x => `${x.pct} %`).join(', ')}, which the Saga saw framed` };
    return { reproduced: fills(big), evidence: notes };
  },
};

// ─── 3. X-wing: the empty ship parks on the rider after an air dismount (SEAT-05) ───

/** What `xwing-air-park-30m` measured (world blocks; `setDown` in the ship's frame: a along the nose, b to its right). */
interface AirPark { alt: number; setDown: { a: number; b: number; y: number }; parkedY: number; depth: number; drawnTail: number; drawnTailOpaque: number; noseReach: number; child: Vec3; ship: Vec3 }

const xwingAirPark: RegressionCase = {
  id: 'xwing-air-park-30m', title: '7140 X-wing (30m): sneak off at ALT 20, float down 7 blocks behind the root, and the empty ship parks with its rear engines touching the child (SEAT-05)',
  evidence: `${SAGA_30M} item 5 (\`e07-side.jpg\`, \`e07-strip.jpg\`); ContentLog-30m-live.txt 01:59:31-42: ship at 7990.5,-60,7700.5 yaw 0, Jump to y -38.06 (ALT 20), CMVT \`{"dismount":"float","from":{"x":7990.5,"y":-38.06,"z":7698.79},"at":{"x":7990.5,"y":-38.96,"z":7693.34}}\` (7.16 behind the root), slow fall to -60, the ship sank at 3 b/s to its own x/z. The course's \`parkOverRider\` reads the same set-down and calls it "not under it" by the FOOTPRINT (\`noseReach\`), never the drawn engines`,
  oldPack: `${PACKS_30M}/7140-xwing-fighter.mcaddon`, newStem: '7140-xwing-fighter', expectNew: 'pass',
  // The replay matches the device's situation to the hundredth (set down -7.16 along the nose, 0 across; landed under
  // it; the ship parked at its own x/z), and the drawn airframe - the trans-orange engine glow included - ends 6.36
  // behind the root: the child's 0.6-wide body clears it by 0.50 (the egress `MARGIN`). On the phone that is the
  // engines at point-blank (e07-strip's last frames: the eye 0.8 from the tail) and, side on, the skin's arms (~0.9
  // wide, not the 0.6 box) over the nozzles' glow (e07-side). Whether the device's "touching/overlapping" is contact
  // or that 0.5 block is not decided by the evidence, so this case does not claim a reproduction.
  limits: 'the simulator reproduces the set-down and the park exactly but finds the parked hull 0.50 block clear of the child\'s body box; it has no model of the player\'s DRAWN skin (arms reach ~0.45 from the centre, the hitbox 0.3) or of a near clip plane, and the device did not measure the gap. Needed: a device measurement (e.g. walk the child toward the parked tail and read where the body stops, or `/tp` it 0.1 at a time) or a rule from the user for how much clearance "clear of the player" means',
  knownUnreproduced: true,
  scenario: pack => ({
    name: 'xwing-air-park-30m', allowLines: vehicleAllow, steps: [{ kind: 'expect', label: 'air dismount and park', check: async ctx => {
      const f = vehicleOf(pack, 'plane');
      const v = await boardAt(ctx, f.typeId, { x: 60.5, z: -1200.5 }, 0, 100);
      // The slow fall is the runtime's (a float set-down); the core fall check still runs on the landing.
      for (let t = 0; t < 200 && v.location.y - FLAT_GROUND_Y < 21.9; t++) { ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: true }); await ctx.run(1); }
      ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false });
      await ctx.run(10);
      const alt = r2(v.location.y - FLAT_GROUND_Y);
      await sneakOff(ctx);
      await ctx.run(3);
      const r = v.rotation.y * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r), rx = -Math.cos(r), rz = -Math.sin(r);
      const p0 = ctx.player.location, dx0 = p0.x - v.location.x, dz0 = p0.z - v.location.z;
      const setDown = { a: r2(dx0 * fx + dz0 * fz), b: r2(dx0 * rx + dz0 * rz), y: r2(p0.y - FLAT_GROUND_Y) };
      for (let t = 0; t < 900 && !ctx.player.onGround; t++) await ctx.run(1);
      await ctx.run(Math.ceil(alt / 3 * 20) + 80);
      const p = ctx.player.location, hull = hullBoxes(pack, v);
      const body = bodyBox(p);
      const depth = hull.reduce((m, b) => Math.max(m, overlapDepth(body, b.box)), -Infinity);
      // How far the DRAWN airframe reaches behind the root, along the nose (the footprint says `noseReach`).
      const tailOf = (boxes: readonly DrawnBox[]): number => boxes.reduce((m, b) => {
        let worst = m;
        for (const x of [b.box.x0, b.box.x1]) for (const z of [b.box.z0, b.box.z1]) worst = Math.max(worst, -((x - v.location.x) * fx + (z - v.location.z) * fz));
        return worst;
      }, 0);
      const tail = tailOf(hull), tailOpaque = tailOf(hull.filter(b => !b.glass));
      const out: AirPark = { alt, setDown, parkedY: r2(v.location.y - FLAT_GROUND_Y), depth: r2(depth), drawnTail: r2(tail), drawnTailOpaque: r2(tailOpaque), noseReach: f.noseReach, child: rel(p, { x: v.location.x, y: FLAT_GROUND_Y, z: v.location.z }), ship: { x: r2(v.location.x), y: r2(v.location.y), z: r2(v.location.z) } };
      ctx.state['airPark'] = out;
      ctx.note(`X-wing air dismount at ALT ${alt}: set down ${setDown.a} along the nose, ${setDown.b} across, y ${setDown.y} (Saga: -7.16, 0, 21.04); landed at ${JSON.stringify(out.child)} from the ship's root; the ship parked ${out.parkedY} over the ground; its drawn airframe reaches ${out.drawnTail} behind the root (${out.drawnTailOpaque} without its translucent parts; footprint ${f.noseReach}); the child's body ${depth > 0 ? `is ${out.depth} INSIDE` : `clears`} the drawn hull${depth > 0 ? '' : ` by ${r2(-depth)}`}`);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
      return undefined;
    } }],
  }),
  judge: r => {
    const s = r.state['airPark'] as AirPark | undefined;
    const notes = r.notes.filter(n => /X-wing air dismount/.test(n)).join('; ') || 'no park note';
    if (!s) return { reproduced: false, evidence: notes, untested: 'the ship was not flown and left' };
    if (s.alt < 15) return { reproduced: false, evidence: notes, untested: `the ship only reached ALT ${s.alt} (the Saga's: 20)` };
    if (s.parkedY > 0.5) return { reproduced: false, evidence: notes, untested: `the ship did not come down (${s.parkedY} up): its park over the child was not tested` };
    // "Touching/overlapping the player" (e07): the body inside the drawn hull, or within 0.05 of it.
    return { reproduced: s.depth > -0.05, evidence: notes };
  },
};

// ─── 4. McLaren between two walls: set down beyond a wall (SEAT-05) ───

/** What `mclaren-walls-30m` measured (blocks from the car's root). */
interface WallEgress { end: Vec3; inGap: boolean; side: 'gap' | 'west' | 'east'; riding: boolean }

const mclarenWalls: RegressionCase = {
  id: 'mclaren-walls-30m', title: '42172 McLaren (30m) parked between two walls: getting off sets the player down on the FAR side of the west wall, through it (SEAT-05)',
  evidence: `${SAGA_30M} item 5 (\`e06-strip.jpg\`, 01:56:41): car at 7980.5,-60,7900.5 yaw 0 (CMVT), stone walls at x 7978 and x 7983, y -60..-58, z 7892..7909 (a 4-block gap); CMVT \`{"dismount":"beside","from":{"x":7980.5,"z":7899.72},"at":{"x":7977.46,"y":-60,"z":7900.98}}\` - the open-ground spot (01:54:26) exactly, beyond the wall`,
  oldPack: `${PACKS_30M}/42172-mclaren-p1.mcaddon`, newStem: '42172-mclaren-p1', expectNew: 'pass', open: OPEN_30M,
  // The Saga's geometry relative to the car's root (60.5, 600.5): wall cells x 58 and 63, z 592..609, three high.
  scenario: pack => ({
    name: 'mclaren-walls-30m', allowLines: vehicleAllow, steps: [{ kind: 'expect', label: 'walls, board, sneak', check: async ctx => {
      const f = vehicleOf(pack, 'car');
      const w = ctx.sim.engine.dimension('overworld'), stone = ctx.sim.host.resolvePermutation('minecraft:stone');
      for (const x of [58, 63]) for (let z = 592; z <= 609; z++) for (let y = 0; y < 3; y++) w.setPermutation(x, FLAT_GROUND_Y + y, z, stone);
      const v = await boardAt(ctx, f.typeId, { x: 60.5, z: 600.5 }, 0, 100);
      await ctx.run(20);
      ctx.quiet([]);
      await sneakOff(ctx);
      await ctx.run(40);
      const p = ctx.player.location, end = rel(p, { x: v.location.x, y: FLAT_GROUND_Y, z: v.location.z });
      // The gap between the walls' inner faces: x 59..63 (the body's 0.3 half width inside it).
      const side: WallEgress['side'] = p.x < 59 ? 'west' : p.x > 63 ? 'east' : 'gap';
      const out: WallEgress = { end, inGap: side === 'gap', side, riding: !!ctx.player.ridingOn };
      ctx.state['wallEgress'] = out;
      ctx.note(`McLaren between walls: after a sneak the player stands at ${JSON.stringify(end)} from the car's root (Saga: -3.04, 0, 0.48), ${side === 'gap' ? 'in the gap between the walls' : `on the ${side.toUpperCase()} side of the ${side} wall`}${out.riding ? ' - STILL RIDING' : ''}`);
      if (ctx.player.ridingOn) v.removeRider(ctx.player);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
      return undefined;
    } }],
  }),
  judge: r => {
    const s = r.state['wallEgress'] as WallEgress | undefined;
    const notes = r.notes.filter(n => /McLaren between walls/.test(n)).join('; ') || 'no egress note';
    if (!s) return { reproduced: false, evidence: notes, untested: 'the car was not boarded' };
    if (s.riding) return { reproduced: false, evidence: notes, untested: 'the sneak did not get the child off' };
    return { reproduced: !s.inGap, evidence: notes };
  },
};

// ─── 5. 10261 at 200 %: off the east end from the curved top (COL-01) ───

/** One walk of `top-east-fall-10261-30m`, anchor-relative. */
interface TopWalk { label: string; top: number; fall: number; from: Vec3 | null; end: Vec3 }
/** Feet this high (blocks over the pin at 200 %) are on the lift's top (the Pixel stood at 43.5-43.6). */
const TOP_Y = 40;
/** The deepest fall a walk may take: the reach guards' limit. */
const SAFE_FALL = REACH_GUARD_DROP16 / 16;

const topEastFall: RegressionCase = {
  id: 'top-east-fall-10261-30m', title: '10261 at 200 % (30m): walking +z along the curved top to pin+(79.5, 43.6, 27.7), then +x, the player walks off the east end and falls 42 blocks (COL-01)',
  evidence: `${PIXEL_30M} item 1 "FAIL (new edge)" (pin 7000,-60,5900, turn 0; \`top-s-east-pos\`, \`frames-top-s-east/pos-montage-small.png\`, \`rec/cm30m-top-s-east.mp4\`, reproduced in \`top-s-east2-pos\`): x 7079 -> 7081, then a fall to 7095.59,-60; the same walk at pin z+16.1 holds at pin x+83.70 (\`top-mid-east-pos\`); the reach guard covers the lift-end lanes, not the east edge at z~27.7`,
  oldPack: `${PACKS_30M}/10261-roller-coaster.mcaddon`, newStem: '10261-roller-coaster', expectNew: 'pass', open: OPEN_30M,
  // The Pixel's walks: from the lift-top stop (pin + 79.70, 43.5, 5.34) along +z to 27.7 ("top-south"), then the
  // repro `/tp @s <pin+79.5> <pin+43.62> <pin+27.7> -90 15` + 4 s of stick toward +x, and the control at z+16.1 (held).
  scenario: () => ({
    name: 'top-east-fall-10261-30m', allowLines: allow, steps: [{ kind: 'place', size: 200, rotation: 0 }, { kind: 'wait', ticks: 40 },
      { kind: 'expect', label: 'walks on the lift top', check: async ctx => {
        const a = placedOf(ctx).anchor;
        const walks: Array<{ label: string; from: Vec3; to: Vec3; ticks: number }> = [
          { label: 'top south (+z to 27.7)', from: { x: 79.7, y: 43.5, z: 5.34 }, to: { x: 79.7, y: 43.5, z: 27.7 }, ticks: 600 },
          { label: 'top south-east (+x at z 27.7)', from: { x: 79.5, y: 43.62, z: 27.7 }, to: { x: 100, y: 43.62, z: 27.7 }, ticks: 400 },
          { label: 'top mid-east (+x at z 16.1)', from: { x: 79.5, y: 43.62, z: 16.1 }, to: { x: 100, y: 43.62, z: 16.1 }, ticks: 400 },
        ];
        const rows: TopWalk[] = [];
        for (const w of walks) {
          await CORE_HANDLERS['walkLine']!({ kind: 'walkLine', label: w.label, autoJump: true, maxFall: SAFE_FALL, maxTicks: w.ticks, from: { x: a.x + w.from.x, y: a.y + w.from.y, z: a.z + w.from.z }, to: { x: a.x + w.to.x, y: a.y + w.to.y, z: a.z + w.to.z } }, ctx);
          const last = ctx.state['lastWalk'] as { end: Vec3; fall: number; fallFrom?: Vec3; highest: number } | undefined;
          if (!last) continue;
          const row: TopWalk = { label: w.label, top: r2(last.highest - a.y), fall: r2(last.fall), from: last.fallFrom ? rel(last.fallFrom, a) : null, end: rel(last.end, a) };
          rows.push(row);
          ctx.note(`10261 ${w.label} (auto-jump): highest feet y ${row.top}, deepest fall ${row.fall}${row.from ? ` from ${JSON.stringify(row.from)}` : ''}, ended ${JSON.stringify(row.end)} (anchor-relative)`);
        }
        ctx.state['topWalks'] = rows;
        return undefined;
      } }],
  }),
  judge: r => {
    const rows = (r.state['topWalks'] as TopWalk[] | undefined) ?? [];
    const notes = r.notes.filter(n => /^(\[tick \d+\] )?10261 top/.test(n)).join('; ') || 'no walk note';
    const east = rows.find(w => /south-east/.test(w.label));
    if (!east || east.top < TOP_Y) return { reproduced: false, evidence: notes, untested: `the +x walk did not start on the lift top (feet y ${TOP_Y}+)` };
    const fall = violated(r, 'walk-no-deep-fall', /south-east/);
    return { reproduced: !!fall, attribution: 'pack', evidence: `${fall ? `${fall}; ` : ''}${notes}` };
  },
};

// ─── 6. 10261 at 400 %: the shell not drawn from 40 blocks west (COL-03) ───

/** One standpoint of `shell-unseen-400-10261-30m`. */
interface ShellView { at: Vec3; shells: number; shellsDrawn: number; others: number; othersDrawn: number; nearestShell: number; cull: number }

const shellUnseen400: RegressionCase = {
  id: 'shell-unseen-400-10261-30m', title: '10261 at 400 % (30m): from 40 blocks west of the pin only figures and cars are drawn - every shell chunk is culled (the lattice is planned for 200 %) (COL-03)',
  evidence: `${PIXEL_30M} item 1 "400 % timing" (fresh pin 6500,-60,5500, 172x100x84; \`14b\`, \`14d\`, the chunks present by \`14k-testfor400.jpg\`): the shell's lattice is planned for \`STATIC_SHELL_CULL_MAX_SCALE\` 2 (bedrock-building-shell.ts: 20-block cells, a root at each cell's top centre), so at 400 % a chunk's root sits up to sqrt(1.5) x 80 = 98 blocks from its own cubes, past the 70-block draw ceiling (quirks \`actor-draw-ceiling\`, \`cull-by-collision-box\`)`,
  oldPack: `${PACKS_30M}/10261-roller-coaster.mcaddon`, newStem: '10261-roller-coaster', expectNew: 'pass', open: OPEN_30M,
  // The phone's picture from 40 blocks west of the pin (two rows: the pin's and the model's middle), looking at the
  // model's centre: each actor's cull from the DRAWN camera (snapshot.ts `clientSnapshot`, the Pixel's client).
  scenario: pack => ({
    name: 'shell-unseen-400-10261-30m', allowLines: allow, steps: [{ kind: 'place', size: 400, rotation: 0 }, { kind: 'wait', ticks: 40 },
      { kind: 'expect', label: 'look from 40 west', check: async ctx => {
        const placed = placedOf(ctx), a = placed.anchor;
        const centre = { x: (placed.from.x + placed.to.x + 1) / 2, y: (placed.from.y + placed.to.y) / 2, z: (placed.from.z + placed.to.z + 1) / 2 };
        const client = ClientView.of(ctx.sim.engine) ?? attachClient(ctx.sim, ctx.player, 'pixel');
        const appearance = appearanceOf(pack);
        const rows: ShellView[] = [];
        for (const z of [a.z, centre.z]) {
          const feet = { x: a.x - 40, y: placed.from.y, z };
          teleport(ctx.sim.host, ctx.player, feet);
          ctx.player.onGround = true;
          lookAt(ctx.player, { x: centre.x, y: feet.y + PLAYER_EYE_HEIGHT, z: centre.z });
          await ctx.run(2);
          const shot = clientSnapshot(ctx.sim.engine, appearance, ctx.player, client, { width: 160, height: 90 });
          const shells = shot.metrics.entities.filter(e => isShellEntityId(e.typeId)), others = shot.metrics.entities.filter(e => !isShellEntityId(e.typeId));
          const row: ShellView = { at: rel(feet, a), shells: shells.length, shellsDrawn: shells.filter(e => e.state !== 'gone').length, others: others.length, othersDrawn: others.filter(e => e.state !== 'gone').length, nearestShell: r2(Math.min(...shells.map(e => e.dist3d))), cull: r2(Math.max(0, ...shells.map(e => e.cullBlocks))) };
          rows.push(row);
          ctx.note(`10261 at 400 % from ${JSON.stringify(row.at)} (pin-relative): shell chunks drawn ${row.shellsDrawn} of ${row.shells} (nearest root ${row.nearestShell} blocks, cull ${row.cull}); other actors drawn ${row.othersDrawn} of ${row.others}`);
        }
        ctx.state['shellViews'] = rows;
        return undefined;
      } }],
  }),
  judge: r => {
    const rows = (r.state['shellViews'] as ShellView[] | undefined) ?? [];
    const notes = r.notes.filter(n => /10261 at 400 % from/.test(n)).join('; ') || 'no view note';
    if (!rows.length || rows.every(v => !v.shells)) return { reproduced: false, evidence: notes, untested: 'no shell chunk was placed at 400 %' };
    // The device's picture: figures/cars drawn, no shell. Any standpoint showing that reproduces it.
    return { reproduced: rows.some(v => v.shells > 0 && v.shellsDrawn === 0 && v.othersDrawn > 0), attribution: 'pack', evidence: notes };
  },
};

// ─── 7. Milano at 200 %: the Mount target is only the small box at the hull centre ───

/** What `milano-mount-reach-200-30m` measured (blocks from the ship's root along the walk). */
interface MountReach { drawnNose: number; box: Box; atNose: { aimHull: boolean; aimBox: boolean }; firstHull: number | null; firstBox: number | null }

const milanoMountReach: RegressionCase = {
  id: 'milano-mount-reach-200-30m', title: '76286 Milano at 200 % (30m): walking up to the nose shows no Mount prompt; it appears only ~3 blocks from the hull centre - the interact target is the 7 x 5 collision box, not the drawn ship (COL-03, SEAT-05)',
  evidence: `${PIXEL_30M} item 3 (\`22a-f\`, \`24d\`): walking toward the nose from z 4995 (pin 8600,-60,5000, root ~8636,5016), no prompt at the nose, the prompt at z 5013 under the hull by the gear leg; at 100 % ~1 block from the root. ${SAGA_30M} item 4: the 200 % box measured 7 x 5 (hits +-3.4, misses +-3.6; top +4.9 / +5.1) - the pack's 3.5 x 2.5 under scale 2 (quirk \`collision-box-scales-with-entity\`); the pick is the collision box (input/ray.ts \`pickBoxes\`, no \`custom_hit_test\`)`,
  oldPack: `${PACKS_30M}/76286-the-milano-spaceship.mcaddon`, newStem: '76286-the-milano-spaceship', expectNew: 'pass', open: OPEN_30M,
  // The ship summoned at 200 % (the device's was placed by the wand at 200 %: the same entity, box and scale). The child
  // walks in along the nose axis from 2 blocks off the drawn nose to the root, every half block aiming (a) at the drawn
  // hull straight ahead at eye height, as a child aims at what it sees, and (b) at the pick box's centre, the best aim.
  scenario: pack => ({
    name: 'milano-mount-reach-200-30m', allowLines: vehicleAllow, steps: [{ kind: 'expect', label: 'walk to the nose and in', check: async ctx => {
      const f = vehicleOf(pack, 'plane');
      const v = ctx.sim.engine.spawnEntity(f.typeId, 'overworld', { x: 60.5, y: FLAT_GROUND_Y, z: -1500.5 });
      v.rotation = { x: 0, y: 0 };
      await ctx.run(2);
      v.triggerEvent('craftmatic:size_200');
      await ctx.run(4);
      const hull = hullBoxes(pack, v), root = v.location;
      // The drawn nose along +z (yaw 0): the farthest drawn point ahead of the root.
      const drawnNose = hull.reduce((m, b) => Math.max(m, b.box.z1 - root.z), 0);
      const box = pickBoxes(v)[0]!;
      const reach = quirkValue('hold-is-interact', 'reachBlocks');
      let firstHull: number | null = null, firstBox: number | null = null, atNose = { aimHull: false, aimBox: false };
      for (let d = drawnNose + 2; d >= 0; d -= 0.5) {
        const feet = { x: root.x, y: FLAT_GROUND_Y, z: root.z + d };
        teleport(ctx.sim.host, ctx.player, feet);
        await ctx.run(1);
        const eye = ctx.player.headLocation();
        // (a) Straight back at the hull at eye height (the child faces the ship): the nearest drawn point on that line.
        lookAt(ctx.player, { x: root.x, y: eye.y, z: root.z });
        const hullHit = pick(ctx.sim.engine, ctx.player, reach).entity === v;
        // (b) The best aim: the pick box's centre.
        lookAt(ctx.player, { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, z: (box.z0 + box.z1) / 2 });
        const boxHit = pick(ctx.sim.engine, ctx.player, reach).entity === v;
        if (hullHit && firstHull === null) firstHull = r2(d);
        if (boxHit && firstBox === null) firstBox = r2(d);
        // "At the nose": standing a body's width off the drawn nose.
        if (Math.abs(d - (drawnNose + 0.5)) < 0.26) atNose = { aimHull: hullHit, aimBox: boxHit };
      }
      const out: MountReach = { drawnNose: r2(drawnNose), box: { x0: r2(box.x0 - root.x), y0: r2(box.y0 - root.y), z0: r2(box.z0 - root.z), x1: r2(box.x1 - root.x), y1: r2(box.y1 - root.y), z1: r2(box.z1 - root.z) }, atNose, firstHull, firstBox };
      ctx.state['mountReach'] = out;
      ctx.note(`Milano at 200 %: the drawn nose is ${out.drawnNose} blocks ahead of the root, the pick box ${out.box.z1 - out.box.z0} x ${out.box.y1 - out.box.y0} about it; at the nose the Mount target is ${atNose.aimHull || atNose.aimBox ? 'PICKED' : 'NOT picked'} (aim at the hull ${atNose.aimHull}, at the box ${atNose.aimBox}); walking in it is first picked ${firstHull ?? 'never'} blocks from the root aiming at the hull, ${firstBox ?? 'never'} aiming at the box (Pixel: ~3); interact reach ${reach}`);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
      return undefined;
    } }],
  }),
  judge: r => {
    const s = r.state['mountReach'] as MountReach | undefined;
    const notes = r.notes.filter(n => /Milano at 200 %: the drawn nose/.test(n)).join('; ') || 'no reach note';
    if (!s) return { reproduced: false, evidence: notes, untested: 'the ship was not spawned' };
    if (s.firstBox === null) return { reproduced: false, evidence: notes, untested: 'the box was never picked, even from under the hull' };
    // The fault the Pixel reported: standing at the drawn nose, no Mount target whatever the aim. How near the centre
    // it first appears differs (the simulator's 5-block interact reach to the box, quirk `hold-is-interact`, picks
    // from ~8 at 200 %; the phone's touch button appeared ~3 blocks from the root: its own reach is not measured).
    return { reproduced: !s.atNose.aimHull && !s.atNose.aimBox, evidence: notes };
  },
};

/** Round 30m's open defects. */
export const ROUND_30M_REGRESSIONS: RegressionCase[] = [nimbusSteer, milanoChase400, xwingAirPark, mclarenWalls, topEastFall, shellUnseen400, milanoMountReach];
