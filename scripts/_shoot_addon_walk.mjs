/**
 * Open a built `.mcaddon` in the LEGO tab's add-on walk and screenshot it.
 *
 * The walk draws what the pack actually ships — the collider blocks and, with
 * the `model` legend row on, what the entity looks like in game — so it
 * answers "does this pack put the right thing in the world" without a device.
 *
 * Runs under NODE (chromium.launch hangs under bun here) with
 * serviceWorkers blocked (the PWA worker intercepts /lego-models/*).
 *
 * Usage: node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers] [mode]
 *   layers: comma-separated legend kinds to leave ON, e.g. "model" or
 *           "model,collider". Default: whatever the walk opens with.
 *   mode: "flyout" (default) — the original fly-back-and-up establishing shot.
 *     "ride" — proves ride-car MOTION and boarding rather than the whole
 *     model: free-fly next to the first `carWorld` entry (via the DEV-only
 *     `window.__addonWalk` hook — a coaster car gets no reach-target "go"
 *     button), shoot it twice `--ride-wait` ms apart (same static camera; the
 *     car should have moved — the printed JSON also gives the exact
 *     `movedDistanceBlocks`), then teleport within reach and press E to board,
 *     shooting the followed-camera view. Writes `<out>`, `<out>.moved.png`
 *     and `<out>.boarded.png`.
 *     "figures" — close up on the first figure marker (also via
 *     `window.__addonWalk`): proves a minifig draws real geometry, not a
 *     placeholder capsule (the printed JSON's `hasRealGeometry`).
 *     "pinball" — free-fly next to the pinball console (via `window.__addonWalk`'s
 *     `pinballIndices`/`model.pinball`), press E to board it (enters pinball
 *     mode: the walk's own `createPinballSim` running live), hold Space ~1 s
 *     to charge the plunger and release to launch, wait ~1.5 s, then hold the
 *     left flipper key. Writes `<out>` (just boarded), `<out>.moved.png`
 *     (after the launch and wait — the printed JSON gives the ball's plane
 *     (u, w) before/after and the LDU distance moved) and `<out>.flipper.png`
 *     (left flipper held up, its angle against rest in the printed JSON).
 *   --ride-wait=<ms>: real time between the two static-camera shots in "ride"
 *     mode (default 2500). The walk's frame loop is a continuous
 *     requestAnimationFrame while open (not the viewer's on-demand one), so a
 *     real wait does advance ride ticks — verify with the two PNGs, not by
 *     assumption.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) flags.set(m[1], m[2]); else positional.push(a);
}
const [packPath, outPath, layersArg, modeArg] = positional;
if (!packPath || !outPath) {
  console.error('usage: node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers] [mode] [--ride-wait=ms]');
  process.exit(64);
}
const mode = modeArg === 'ride' ? 'ride' : modeArg === 'figures' ? 'figures' : modeArg === 'pinball' ? 'pinball' : 'flyout';
const rideWaitMs = Number(flags.get('ride-wait') ?? 2500);
const wanted = layersArg ? layersArg.split(',').map(s => s.trim()).filter(Boolean) : null;
mkdirSync(outPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
/** `out/dir/name.png` -> `out/dir/name.suffix.png`. */
const withSuffix = (p, suffix) => p.replace(/(\.[^./\\]+)$/, `.${suffix}$1`);

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

await page.goto('http://localhost:4000/?tab=lego', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#lego-addon-walk-file', { state: 'attached', timeout: 30000 });
await page.setInputFiles('#lego-addon-walk-file', resolve(packPath));

// The walk mounts its own panel; wait for the legend rather than a timer.
await page.waitForSelector('.ap-tog', { timeout: 120000 });
await page.waitForTimeout(2500);

if (wanted) {
  // Each legend row has a show/hide toggle keyed by `data-kind`.
  const kinds = await page.$$eval('.ap-tog[data-act="show"]', els =>
    els.map(e => ({ kind: e.dataset.kind, on: e.getAttribute('aria-pressed') === 'true' })));
  for (const { kind, on } of kinds) {
    const shouldBeOn = wanted.includes(kind);
    if (on !== shouldBeOn) {
      await page.click(`.ap-tog[data-act="show"][data-kind="${kind}"]`);
      await page.waitForTimeout(120);
    }
  }
  await page.waitForTimeout(1200);
}

const readState = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.ap-tog[data-act="show"]')]
    .map(e => `${e.dataset.kind}:${e.getAttribute('aria-pressed') === 'true' ? 'on' : 'off'}`);
  const title = document.querySelector('.ap-title')?.textContent?.trim().slice(0, 120) ?? '';
  const legend = (document.querySelector('.ap-legend, .ap-panel')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 400);
  const hint = document.querySelector('.ap-hint')?.textContent?.trim() ?? '';
  const interact = document.querySelector('.ap-interact')?.textContent?.trim() ?? '';
  return { title, layers: rows, legend, hint, interact };
});

if (mode === 'flyout') {
  // Fly out so the shot shows the model, not the inside of a brick: free-fly,
  // then rise and back off. A walk that opens at the player's eye height is
  // standing inside the build.
  await page.mouse.click(900, 430);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  for (let i = 0; i < 40; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(30); }
  for (let i = 0; i < 150; i++) { await page.keyboard.press('KeyS'); await page.waitForTimeout(20); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);

  const state = await readState();
  await page.screenshot({ path: outPath });
  console.log(JSON.stringify({ pack: packPath, out: outPath, ...state, errors: errors.slice(0, 5) }, null, 1));
  await browser.close();
} else if (mode === 'figures') {
  // Close up on the first FIGURE marker, via the same DEV-only `window.__addonWalk`
  // hook "ride" mode uses: proves a minifig draws the pack's own resource-pack
  // geometry (bone hierarchy, per-part colours) rather than a placeholder capsule.
  await page.mouse.click(900, 430);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // The red/green reach overlay plates are on by default and would fill a
  // close-up shot from inside the footprint; this mode is about the model,
  // not reach, so turn them off.
  await page.evaluate(() => { const btn = document.querySelector('[data-act="reach"]'); if (btn instanceof HTMLElement && btn.getAttribute('aria-pressed') === 'true') btn.click(); });
  await page.waitForTimeout(100);

  const placed = await page.evaluate(() => {
    const w = window.__addonWalk;
    if (!w) return { ok: false, reason: 'no __addonWalk dev hook (not a DEV build?)' };
    const marker = w.markers.find(m => m.entity.kind === 'figure');
    if (!marker) return { ok: false, reason: 'no figure marker in this pack' };
    const at = marker.at;
    // Camera due +Z of the figure at eye height, facing yaw 0 (this codebase's
    // convention: yaw 0 looks down -Z, so a camera at larger z than its target
    // faces it with no trigonometry needed).
    w.state = { ...w.state, x: at.x, y: at.y + 0.9, z: at.z + 2.4, vx: 0, vy: 0, vz: 0 };
    w.prevState = w.state;
    w.yaw = 0;
    w.pitch = -0.15;
    return { ok: true, label: marker.entity.label, hasRealGeometry: marker.hasRealGeometry, at: { x: at.x, y: at.y, z: at.z } };
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: outPath });
  await browser.close();
  console.log(JSON.stringify({ pack: packPath, mode, out: outPath, placed, errors: errors.slice(0, 5) }, null, 1));
} else if (mode === 'pinball') {
  // Free-fly next to the pinball console, found via `window.__addonWalk`'s
  // `pinballIndices`/`model.pinball` (the console has no reach-target "go"
  // button either — same documented gap as a coaster car). Board it with E,
  // then drive the plunger and a flipper directly with the keyboard, exactly
  // as a person would: `pinballInputForTick` reads the same key codes.
  await page.mouse.click(900, 430);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const placed = await page.evaluate(() => {
    const w = window.__addonWalk;
    if (!w) return { ok: false, reason: 'no __addonWalk dev hook (not a DEV build?)' };
    if (!w.model.pinball || !w.pinballIndices) return { ok: false, reason: 'this pack has no playable pinball table (no scripts/pinball.js, or its actors are missing)' };
    const marker = w.markerByIndex.get(w.pinballIndices.console);
    if (!marker) return { ok: false, reason: 'no marker for the console entity' };
    const p = marker.at;
    w.state = { ...w.state, x: p.x - 1.5, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0 };
    w.prevState = w.state;
    w.yaw = Math.atan2(-(p.x - w.state.x), -(p.z - w.state.z));
    w.pitch = -0.1;
    return { ok: true, console: w.model.entities[w.pinballIndices.console].label, at: { x: p.x, y: p.y, z: p.z } };
  });
  if (!placed.ok) {
    await page.screenshot({ path: outPath });
    console.log(JSON.stringify({ pack: packPath, mode, out: outPath, placed, errors: errors.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(400);

  const readBall = () => page.evaluate(() => {
    const w = window.__addonWalk;
    const st = w.pinball ? w.pinball.sim.state : null;
    return st ? { u: st.u, w: st.w, phase: st.phase, score: st.score, ball: st.ball, charge: st.charge } : null;
  });
  const afterBoard = await page.evaluate(() => ({
    boarded: !!window.__addonWalk?.pinball,
    interact: document.querySelector('.ap-interact')?.textContent ?? '',
    hint: document.querySelector('.ap-hint')?.textContent ?? '',
  }));
  const ballBefore = await readBall();
  await page.screenshot({ path: outPath });

  // Hold the plunger ~1 s (charges it; the sim's default full-charge time is
  // 1 s), release (fires the ball up the table), then let it run ~1.5 s.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(1500);
  const ballAfter = await readBall();
  const movedPath = withSuffix(outPath, 'moved');
  await page.screenshot({ path: movedPath });
  const movedDistanceLdu = ballBefore && ballAfter ? Math.hypot(ballAfter.u - ballBefore.u, ballAfter.w - ballBefore.w) : null;

  // Hold the left flipper. The table's own fixed spectator camera (the real
  // runtime's `cameraEye`/`cameraLook`, applied every frame by
  // `applyPinballCamera`) frames the whole table from behind and above, too
  // far out for a few degrees of swing to read clearly in a screenshot — so,
  // for this ONE shot only, shadow that method with an own-property override
  // (the walk calls `this.applyPinballCamera()`, an ordinary prototype
  // method, so an instance property of the same name wins) that instead
  // frames the left flipper's own placed point up close; `delete` restores
  // the table camera for anything after. The sim and the flipper's actual
  // pose are untouched — only where we are looking from.
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(250);
  const closeUp = await page.evaluate(() => {
    const w = window.__addonWalk;
    if (!w?.pinball || !w.pinballIndices) return { ok: false, reason: 'not boarded' };
    const holder = w.entityHolders.get(w.pinballIndices.flippers[0]);
    if (!holder) return { ok: false, reason: 'no holder for the left flipper' };
    // The CENTROID of the flipper's own rendered cube instances, in world
    // space — not the entity's placement origin (`AddonEntity.x/y/z`) or its
    // pivot: the compiled geometry's bind-pose bones can sit many blocks from
    // either (bone pivots are raw 1/16-block units that ran to -47 on this
    // pack's flipper, ~9 world blocks off at this size), so sampling the
    // actual instance matrices is the only reliable "where is it" here.
    // `Vector3`/`Matrix4` are read off already-live THREE objects (the
    // camera's own), since THREE itself is not on `window`.
    const Vector3 = w.camera.position.constructor;
    const Matrix4 = w.camera.matrixWorld.constructor;
    holder.updateWorldMatrix(true, false);
    const m = new Matrix4();
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const mesh of holder.children) {
      if (!mesh.isInstancedMesh) continue;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        const p = new Vector3().setFromMatrixPosition(m).applyMatrix4(holder.matrixWorld);
        sx += p.x; sy += p.y; sz += p.z; n++;
      }
    }
    if (!n) return { ok: false, reason: 'no cube instances found on the flipper holder' };
    const at = { x: sx / n, y: sy / n, z: sz / n };
    w.applyPinballCamera = () => {
      w.camera.up.set(0, 1, 0);
      w.camera.position.set(at.x - 2, at.y + 1.6, at.z + 2);
      w.camera.lookAt(at.x, at.y, at.z);
    };
    return { ok: true, at, sampled: n };
  });
  await page.waitForTimeout(150);
  const flipperState = await page.evaluate(() => {
    const w = window.__addonWalk;
    if (!w?.pinball) return null;
    return { angles: w.pinball.sim.state.flipperAngles.slice(), rest: w.model.pinball.restAngles, spinSign: w.model.pinball.spinSign };
  });
  const flipperPath = withSuffix(outPath, 'flipper');
  await page.screenshot({ path: flipperPath });
  await page.keyboard.up('KeyA');
  await page.evaluate(() => { const w = window.__addonWalk; if (w) delete w.applyPinballCamera; });

  await browser.close();
  console.log(JSON.stringify({
    pack: packPath, mode, out: outPath, movedPath, flipperPath,
    placed, afterBoard, ballBefore, ballAfter, movedDistanceLdu, closeUp, flipperState, errors: errors.slice(0, 5),
  }, null, 1));
} else {
  // "ride": free-fly, then place the camera off the DEV-only `window.__addonWalk`
  // hook (same convention as viewer.ts's `__ldrawViewer`) instead of guessing
  // scene coordinates — coaster cars get no reach-target "go" button (a
  // documented gap: only figure/seat/door/station/lift do), so this is the
  // reliable way to find one. Reads carWorld/coasterStates directly (numeric
  // proof of motion, not just a pixel diff) and teleports free-fly `state`
  // near the first car for a still shot, then close enough to board it.
  await page.mouse.click(900, 430);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const place = (dx, dz) => page.evaluate(([dx, dz]) => {
    const w = window.__addonWalk;
    if (!w) return { ok: false, reason: 'no __addonWalk dev hook (not a DEV build?)' };
    const car = [...w.carWorld.values()][0];
    if (!car) return { ok: false, reason: 'carWorld is empty (no route with a car?)' };
    w.state = { ...w.state, x: car.x + dx, y: car.y, z: car.z + dz, vx: 0, vy: 0, vz: 0 };
    w.prevState = w.state;
    w.yaw = Math.atan2(-(car.x - w.state.x), -(car.z - w.state.z));
    w.pitch = -0.1;
    return { ok: true, car: { x: car.x, y: car.y, z: car.z, yawDeg: car.yawDeg, moving: car.frame.moving }, phase: [...w.coasterStates.values()][0]?.phase, speed: [...w.coasterStates.values()][0]?.speed };
  }, [dx, dz]);

  const before = await place(-5, -5);
  await page.waitForTimeout(150);
  await page.screenshot({ path: outPath });
  await page.waitForTimeout(rideWaitMs);
  const after = await page.evaluate(() => {
    const w = window.__addonWalk;
    const car = w ? [...w.carWorld.values()][0] : null;
    return car ? { x: car.x, y: car.y, z: car.z, yawDeg: car.yawDeg, moving: car.frame.moving } : null;
  });
  const movedPath = withSuffix(outPath, 'moved');
  await page.screenshot({ path: movedPath });
  const moved = before.ok && after ? Math.hypot(after.x - before.car.x, after.y - before.car.y, after.z - before.car.z) : null;

  // Board: teleport within reach (2.5 blocks) of the car's CURRENT position, then press E.
  const near = await place(0, -1.2);
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(500);
  const boardedState = await page.evaluate(() => {
    const w = window.__addonWalk;
    return w ? { riding: !!w.riding, interact: document.querySelector('.ap-interact')?.textContent ?? '', hint: document.querySelector('.ap-hint')?.textContent ?? '' } : null;
  });
  const boardedPath = withSuffix(outPath, 'boarded');
  await page.screenshot({ path: boardedPath });

  await browser.close();
  console.log(JSON.stringify({
    pack: packPath, mode, out: outPath, movedPath, boardedPath,
    before, after, movedDistanceBlocks: moved, near, boardedState, errors: errors.slice(0, 5),
  }, null, 1));
}
