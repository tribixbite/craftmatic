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
 *   --size=<pct>: click that wand size step before the mode's own sequence
 *     runs (default: whatever the walk opens at — its measured walk-through
 *     recommendation, or 100 without one). Every position sampled off
 *     `window.__addonWalk` (console, ball, flippers) is read AFTER this, so
 *     it is correct at any size.
 *   --url=<base>: the dev server to drive (default http://localhost:4000).
 *     A worktree's own `bun dev:web -- --port N --strictPort` renders ITS
 *     code; the main checkout's server on 4000 renders the main checkout's.
 *   --figure=<n|text>: "figures" mode only — the n-th figure marker
 *     (0-based) or the first whose label contains the text, instead of the
 *     first figure.
 *   --view=front|back: "figures" mode only — put the camera on the side the
 *     figure faces (front, the default: faces and prints) or behind it.
 *   --distance=<blocks>: "figures" mode only — how far from the figure the
 *     camera stands (default 2.4; a big-fig or a 150 % pack wants 3.5-4).
 *   --kind=<marker kind>: "figures" mode only — frame a marker of another
 *     kind the same way (`car` for a coaster car and its posed riders).
 *   --isolate: "figures" mode only — hide every other entity's geometry so
 *     the framed one is seen through the building it stands in.
 *     "doors" — a moving part (bedrock-interactives.ts) closed, opened and
 *     walked through: the camera stands `--distance` blocks out along the
 *     leaf's normal (`--side=front|back`) looking at it, shoots it CLOSED
 *     (`<out>`), toggles it the way E does (`toggleInteractive`, the pack's
 *     own runtime rules: double doors together, a too-small opening stays
 *     blocked) and shoots it OPEN (`<out>.open.png`), then drops a walking
 *     player 1.6 blocks out, holds W for 3 s and shoots where it got to
 *     (`<out>.through.png`); the JSON says whether the feet crossed the leaf
 *     plane. `--door=<n|text>` picks the item (default 0).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) flags.set(m[1], m[2]);
  else if (a.startsWith('--')) flags.set(a.slice(2), '');   // a bare switch such as --isolate
  else positional.push(a);
}
const [packPath, outPath, layersArg, modeArg] = positional;
if (!packPath || !outPath) {
  console.error('usage: node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers] [mode] [--ride-wait=ms]');
  process.exit(64);
}
const mode = modeArg === 'ride' ? 'ride' : modeArg === 'figures' ? 'figures' : modeArg === 'pinball' ? 'pinball' : modeArg === 'doors' ? 'doors' : 'flyout';
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

// --url=, or CRAFTMATIC_URL, points the shot at another dev server (a
// worktree's own, on another port), so a change is looked at through the
// code that made it.
const baseUrl = (flags.get('url') ?? process.env.CRAFTMATIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
await page.goto(`${baseUrl}/?tab=lego`, { waitUntil: 'domcontentloaded' });
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

const sizeArg = flags.get('size') ? Number(flags.get('size')) : null;
if (sizeArg) {
  const clicked = await page.evaluate((pct) => {
    const btn = document.querySelector(`.ap-tog[data-act="size"][data-size="${pct}"]`);
    if (btn instanceof HTMLElement) { btn.click(); return true; }
    return false;
  }, sizeArg);
  if (!clicked) { console.error(`--size=${sizeArg}: no such size step on this pack`); process.exit(64); }
  // A size change rebuilds the whole world (colliders, model, reach); give it
  // a real beat before anything reads positions off it.
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

  const which = flags.get('figure') ?? '0';
  const view = flags.get('view') === 'back' ? 'back' : 'front';
  const distance = Number(flags.get('distance') ?? 2.4);
  // `--kind=car` (or any marker kind) frames that entity the same way: a
  // coaster car's posed riders are part of the car, not figure markers.
  const kind = flags.get('kind') ?? 'figure';
  // `--isolate` hides every other entity's geometry (the walk keeps one
  // THREE.Group per drawn entity), so a car parked inside a building can be
  // photographed through its walls. The collider blocks stay.
  const isolate = flags.has('isolate');
  const placed = await page.evaluate(({ which, view, distance, kind, isolate }) => {
    const w = window.__addonWalk;
    if (!w) return { ok: false, reason: 'no __addonWalk dev hook (not a DEV build?)' };
    const figures = w.markers.filter(m => m.entity.kind === kind);
    const marker = /^\d+$/.test(which) ? figures[Number(which)] : figures.find(m => (m.entity.label ?? '').includes(which));
    if (!marker) return { ok: false, reason: `no ${kind} marker "${which}" in this pack (${figures.length} of that kind)` };
    if (isolate) {
      const index = w.model.entities.indexOf(marker.entity);
      for (const [i, holder] of w.entityHolders) holder.visible = i === index;
    }
    const at = marker.at;
    // The entity's forward is -Z turned by its yaw (plus the placement's
    // quarter turns, as the walk applies to its holder); "front" puts the
    // camera 2.4 blocks along that forward and looks back at the figure, so
    // the face and the prints are in view. This codebase's camera yaw 0 looks
    // down -Z, so looking back along the forward is the entity yaw plus a
    // half turn.
    const yaw = ((marker.entity.yaw ?? 0) + (w.rotation ?? 0) * 90) * Math.PI / 180;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const sign = view === 'front' ? 1 : -1;
    w.state = { ...w.state, x: at.x + fx * distance * sign, y: at.y + 0.9 * (distance / 2.4), z: at.z + fz * distance * sign, vx: 0, vy: 0, vz: 0 };
    w.prevState = w.state;
    w.yaw = view === 'front' ? yaw + Math.PI : yaw;
    w.pitch = -0.15;
    return { ok: true, label: marker.entity.label, view, hasRealGeometry: marker.hasRealGeometry, at: { x: at.x, y: at.y, z: at.z }, figures: figures.length };
  }, { which, view, distance, kind, isolate });
  await page.waitForTimeout(400);
  await page.screenshot({ path: outPath });
  await browser.close();
  console.log(JSON.stringify({ pack: packPath, mode, out: outPath, placed, errors: errors.slice(0, 5) }, null, 1));
} else if (mode === 'doors') {
  await page.mouse.click(900, 430);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.evaluate(() => { const btn = document.querySelector('[data-act="reach"]'); if (btn instanceof HTMLElement && btn.getAttribute('aria-pressed') === 'true') btn.click(); });
  await page.evaluate(() => { const hud = document.querySelector('.ap-hud'); if (hud) hud.style.display = 'none'; });
  const which = flags.get('door') ?? '0';
  const distance = Number(flags.get('distance') ?? 3.2);
  const side = flags.get('side') === 'back' ? -1 : 1;
  // --elev=<blocks>: camera height above the door's foot (default 1.2, eye level); --isolate: draw only this part (and the shell with --isolate=shell).
  const elev = Number(flags.get('elev') ?? 1.2);
  const isolate = flags.has('isolate') ? (flags.get('isolate') || 'part') : null;
  const frame = await page.evaluate(({ which, distance, side, elev, isolate }) => {
    const w = window.__addonWalk;
    if (!w) return { ok: false, reason: 'no __addonWalk dev hook (not a DEV build?)' };
    const cfg = w.model.interactives;
    if (!cfg) return { ok: false, reason: 'this pack ships no moving parts (no scripts/interactives.js)' };
    const index = /^\d+$/.test(which) ? Number(which) : cfg.items.findIndex(it => it.label.includes(which));
    const item = cfg.items[index];
    if (!item) return { ok: false, reason: `no moving part "${which}" (${cfg.items.length} in the pack)` };
    const entityIndex = w.model.entities.findIndex(e => e.interactive === index);
    const marker = w.markerByIndex.get(entityIndex);
    if (!marker) return { ok: false, reason: 'no marker for that entity' };
    const at = marker.at;
    // The leaf's normal through the placement's own turn (the walk's placedDirection convention).
    const r = w.rotation, n = item.normal ?? [0, 0, 1];
    const turn = (x, z) => r === 90 ? { x: -z, z: x } : r === 180 ? { x: -x, z: -z } : r === 270 ? { x: z, z: -x } : { x, z };
    const nn = turn(n[0], n[2]), nl = Math.hypot(nn.x, nn.z) || 1;
    const nx = nn.x / nl * side, nz = nn.z / nl * side;
    const f = w.sizePct / 100;
    const eye = { x: at.x + nx * distance * Math.max(1, f), y: at.y + elev * Math.max(1, f), z: at.z + nz * distance * Math.max(1, f) };
    w.noclip = true;
    w.state = { ...w.state, x: eye.x, y: eye.y - 1.62, z: eye.z, vx: 0, vy: 0, vz: 0, onGround: false };
    w.prevState = w.state;
    w.yaw = Math.atan2(nx, nz);
    // Look at the middle of the leaf (about 1.2 blocks up at 100 %).
    w.pitch = -Math.atan2(eye.y - (at.y + 1.2 * Math.max(1, f)), distance * Math.max(1, f));
    if (isolate) {
      const shells = new Set(w.model.entities.map((e, i) => e.kind === 'shell' ? i : -1).filter(i => i >= 0));
      for (const [i, holder] of w.entityHolders) holder.visible = i === entityIndex || (isolate === 'shell' && shells.has(i));
    }
    return { ok: true, index, label: item.label, kind: item.kind, opening: item.opening, passSize: item.passSize, at: { x: at.x, y: at.y, z: at.z }, normal: { x: nx, z: nz } };
  }, { which, distance, side, elev, isolate });
  if (!frame.ok) {
    console.log(JSON.stringify({ pack: packPath, mode, placed: frame, errors: errors.slice(0, 5) }, null, 1));
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: outPath });
  await page.evaluate((index) => window.__addonWalk.toggleInteractive(index), frame.index);
  await page.waitForTimeout(900);
  const openPath = withSuffix(outPath, 'open');
  await page.screenshot({ path: openPath });
  const status = await page.evaluate(() => document.querySelector('#lego-status, .lego-status, .status')?.textContent?.trim()?.slice(0, 200) ?? '');
  // Walk it: a real (colliding) player 1.6 blocks out on the camera's side, holding W toward the doorway.
  const start = await page.evaluate(({ frame }) => {
    const w = window.__addonWalk;
    const f = w.sizePct / 100;
    w.noclip = false;
    const p = { x: frame.at.x + frame.normal.x * 1.6 * Math.max(1, f), z: frame.at.z + frame.normal.z * 1.6 * Math.max(1, f) };
    w.state = { ...w.state, x: p.x, y: frame.at.y + 0.3, z: p.z, vx: 0, vy: 0, vz: 0, onGround: false };
    w.prevState = w.state;
    w.yaw = Math.atan2(frame.normal.x, frame.normal.z);
    w.pitch = 0;
    return { x: w.state.x, y: w.state.y, z: w.state.z };
  }, { frame });
  await page.waitForTimeout(300);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  const end = await page.evaluate(({ frame }) => {
    const w = window.__addonWalk;
    const s = w.state;
    // Signed distance past the leaf plane, measured from the start side (positive = through).
    const crossed = -((s.x - frame.at.x) * frame.normal.x + (s.z - frame.at.z) * frame.normal.z);
    return { x: s.x, y: s.y, z: s.z, crossedBlocks: Math.round(crossed * 100) / 100 };
  }, { frame });
  const throughPath = withSuffix(outPath, 'through');
  await page.screenshot({ path: throughPath });
  await browser.close();
  console.log(JSON.stringify({ pack: packPath, mode, out: outPath, openPath, throughPath, placed: frame, status, walk: { start, end, through: end.crossedBlocks > 0.5 }, errors: errors.slice(0, 5) }, null, 1));
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

  // Hide the side panels directly (a click toggles from whatever state the
  // walk opened in, which is unreliable to predict) — cleaner evidence, and
  // it also stops them covering the lower-left of the canvas, which the
  // overview camera below can otherwise frame right behind.
  await page.evaluate(() => { const hud = document.querySelector('.ap-hud'); if (hud) hud.style.display = 'none'; });

  // Confirm the board actually SWITCHED the view: entering pinball mode
  // forces the reach overlay and the collider/tread debug boxes off and the
  // full-detail model on (a pinball playfield's own surfaces read almost
  // entirely "not reached" — nothing there is meant to be walked on — so
  // left on, the reach overlay paints the whole shell red and the grey
  // collider boxes bury the real geometry under it).
  const view = await page.evaluate(() => {
    const w = window.__addonWalk;
    return w ? { boarded: !!w.pinball, showReach: w.showReach, modelShown: w.legend.model.show, colliderShown: w.legend.collider.show, treadShown: w.legend.tread.show, sizePct: w.sizePct } : null;
  });

  // In-page helpers, attached to `window` (each `page.evaluate` call runs its
  // own isolated function, sharing nothing but the page's global object):
  //   __centroid(holder): the CENTROID of an entity's own rendered cube
  //     instances, in world space — not its placement origin or bone pivot.
  //     A flipper's compiled bind-pose bones can sit many blocks from either
  //     (this pack's ran to -47 in raw 1/16-block units, ~9 world blocks off
  //     at 300 %), so sampling the actual instance matrices is the only
  //     reliable "where is it" here.
  //   __shellTopY(): the shell's own highest rendered cube, cached — a
  //     suitcase-style machine's side walls run most of its height, so an
  //     overview camera framed only on the LOW console/ball/flipper points
  //     (all near the playfield floor) sits barely above those walls and
  //     ends up grazing one at close range instead of looking down past it.
  //   __overviewCamera(points, elevation): an INDEPENDENT camera framing —
  //     not the table's own `cameraEye`/`cameraLook` (`applyPinballCamera`).
  //     That fixed spectator view is a first-person "what the seated player
  //     sees" shot: correct on its own terms, but on this pack it frames a
  //     recessed patch of the cabinet interior from low behind the console,
  //     with the open playfield largely out of frame — not a rendering bug
  //     (the maths matches the runtime's own `toWorld` exactly, verified
  //     against bedrock-pinball.test.ts's numbers), just a poor angle for
  //     PROVING the game plays, which is this shot's only job. The overview
  //     instead frames a 3/4, elevated view sized to the given points'
  //     bounding box, guaranteed to fit them all, by shadowing
  //     `applyPinballCamera` — an ordinary prototype method, so this
  //     instance property wins every frame until deleted.
  await page.evaluate(`
    window.__centroid = (holder) => {
      if (!holder) return null;
      const Vector3 = window.__addonWalk.camera.position.constructor;
      const Matrix4 = window.__addonWalk.camera.matrixWorld.constructor;
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
      return n ? { x: sx / n, y: sy / n, z: sz / n } : null;
    };
    window.__shellTopY = () => {
      const w = window.__addonWalk;
      if (window.__shellTopYCache !== undefined) return window.__shellTopYCache;
      const shellIdx = w.model.entities.findIndex(e => e.kind === 'shell');
      const holder = w.entityHolders.get(shellIdx);
      let top = 0;
      if (holder) {
        const Vector3 = w.camera.position.constructor;
        const Matrix4 = w.camera.matrixWorld.constructor;
        holder.updateWorldMatrix(true, false);
        const m = new Matrix4();
        for (const mesh of holder.children) {
          if (!mesh.isInstancedMesh) continue;
          for (let i = 0; i < mesh.count; i++) {
            mesh.getMatrixAt(i, m);
            top = Math.max(top, new Vector3().setFromMatrixPosition(m).applyMatrix4(holder.matrixWorld).y);
          }
        }
      }
      window.__shellTopYCache = top;
      return top;
    };
    window.__overviewCamera = (points, marginBlocks) => {
      const w = window.__addonWalk;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const p of points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      if (!isFinite(minX)) return null;
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxZ - minZ, maxY - minY, 2) + marginBlocks * 2;
      // A suitcase-style cabinet's side walls run most of its own height, so
      // clear ALL of them (the shell top), not just the low playfield points
      // being framed, then look down at a steep-but-not-vertical angle -- a
      // gentle horizontal pull-back keeps it a recognisable 3/4 view rather
      // than a flat blueprint-style top-down.
      // Near-vertical on purpose: a bigger horizontal pull-back reads as a
      // nicer 3/4 angle when it works, but on a suitcase-style cabinet with a
      // hinged lid propped open, the pulled-back sight line from the
      // player's own side runs along the BACK of that raised lid instead of
      // over it (its flat outer face is what filled the frame before this).
      // Almost-overhead has nothing left to graze except the model itself.
      const camY = Math.max(cy + span * 2, __shellTopY() + span * 0.8);
      const pullBack = span * 0.18;
      const at = { x: cx, y: cy, z: cz };
      window.__addonWalk.applyPinballCamera = () => {
        w.camera.up.set(0, 1, 0);
        w.camera.position.set(cx, camY, cz + pullBack);
        w.camera.lookAt(cx, cy, cz);
      };
      return { at, span, camY, pullBack };
    };
    // A single flipper is small enough that the whole-cabinet lid problem
    // above does not apply — a lower, more oblique angle shows a raised
    // paddle's silhouette far better than looking straight down its own
    // rotation axis (a top-down view of an in-plane swing barely changes).
    window.__flipperCloseup = (at, span) => {
      const w = window.__addonWalk;
      const dist = Math.max(span * 2.2, 3);
      window.__addonWalk.applyPinballCamera = () => {
        w.camera.up.set(0, 1, 0);
        w.camera.position.set(at.x - dist * 0.5, at.y + dist * 0.6, at.z + dist * 0.7);
        w.camera.lookAt(at.x, at.y, at.z);
      };
      return { at, span, dist };
    };
  `);

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

  // Shot 1: boarded, ready to launch — framed on the console, the ball at
  // its serve point and both flippers, so the whole play area is in view.
  const overview1 = await page.evaluate(() => {
    const w = window.__addonWalk;
    const idx = w.pinballIndices;
    // The console itself sits well OUTSIDE the shell (in front of the
    // machine, on the ground where a player would stand) — including it
    // would force a much wider zoom-out for no benefit, since its own
    // direction is already implied by the flippers it faces.
    const points = [__centroid(w.entityHolders.get(idx.ball)),
      __centroid(w.entityHolders.get(idx.flippers[0])), __centroid(w.entityHolders.get(idx.flippers[1]))]
      .filter(Boolean).map(p => ({ x: p.x, y: p.y, z: p.z }));
    return { points, cam: __overviewCamera(points, 3) };
  });
  const ballBefore = await readBall();
  await page.waitForTimeout(100);
  await page.screenshot({ path: outPath });

  // Hold the plunger ~1 s (charges it; the sim's default full-charge time is
  // 1 s), release (fires the ball up the table), then let it run ~1.5 s.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(1500);
  const ballAfter = await readBall();

  // Shot 2: after the launch — re-framed on the ball's CURRENT position and
  // both flippers, so a ball that travelled well up the table stays in view
  // (the numeric plane (u, w) before/after is the rigorous proof either way).
  const overview2 = await page.evaluate(() => {
    const w = window.__addonWalk;
    const idx = w.pinballIndices;
    const points = [__centroid(w.entityHolders.get(idx.ball)),
      __centroid(w.entityHolders.get(idx.flippers[0])), __centroid(w.entityHolders.get(idx.flippers[1]))]
      .filter(Boolean).map(p => ({ x: p.x, y: p.y, z: p.z }));
    return { points, cam: __overviewCamera(points, 4) };
  });
  const movedPath = withSuffix(outPath, 'moved');
  await page.waitForTimeout(100);
  await page.screenshot({ path: movedPath });
  const movedDistanceLdu = ballBefore && ballAfter ? Math.hypot(ballAfter.u - ballBefore.u, ballAfter.w - ballBefore.w) : null;

  // Shot 3: hold the left flipper and re-frame TIGHT on it alone (re-sampled
  // now that it has actually swung) — a few degrees of swing reads as noise
  // in the whole-playfield framing above.
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(250);
  const overview3 = await page.evaluate(() => {
    const w = window.__addonWalk;
    const at = __centroid(w.entityHolders.get(w.pinballIndices.flippers[0]));
    if (!at) return { ok: false };
    return { ok: true, cam: __flipperCloseup(at, 3.2) };
  });
  const flipperState = await page.evaluate(() => {
    const w = window.__addonWalk;
    if (!w?.pinball) return null;
    return { angles: w.pinball.sim.state.flipperAngles.slice(), rest: w.model.pinball.restAngles, spinSign: w.model.pinball.spinSign };
  });
  const flipperPath = withSuffix(outPath, 'flipper');
  await page.waitForTimeout(100);
  await page.screenshot({ path: flipperPath });
  await page.keyboard.up('KeyA');
  await page.evaluate(() => { const w = window.__addonWalk; if (w) delete w.applyPinballCamera; });

  await browser.close();
  console.log(JSON.stringify({
    pack: packPath, mode, out: outPath, movedPath, flipperPath,
    view, placed, afterBoard, overview1, ballBefore, ballAfter, movedDistanceLdu, overview2, overview3, flipperState, errors: errors.slice(0, 5),
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
