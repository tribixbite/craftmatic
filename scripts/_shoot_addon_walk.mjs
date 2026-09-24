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
const mode = modeArg === 'ride' ? 'ride' : modeArg === 'figures' ? 'figures' : 'flyout';
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
