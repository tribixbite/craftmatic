/**
 * Open a built `.mcaddon` in the LEGO tab's add-on walk and photograph it.
 *
 * The walk runs the pack in the headless simulator (web/src/ui/addon-sim-worker.ts)
 * and draws what it says, so a shot here is the drawn picture of the same tick
 * `bun scripts/sim.ts` reports - the device round's frame sheets, offline. A
 * mode that moves (drive, fly, ride, figures-live, doors) writes a STRIP: a
 * sheet of frames every `--strip=N` ticks, each stamped with its tick, under
 * 2000 px wide (4 tiles of 480 px a row), beside a JSON of what the
 * simulator measured (poses, the camera, the lines it printed, the
 * invariants it raised).
 *
 * Runs under NODE (chromium.launch hangs under bun here) with service workers
 * blocked (the PWA worker intercepts /lego-models/*).
 *
 * Usage: node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers] [mode] [flags]
 *   layers: comma-separated legend kinds to leave ON, e.g. "model" or
 *           "model,collider". Default: whatever the walk opens with.
 *   mode:
 *     flyout (default)  an establishing three-quarter shot of everything drawn.
 *     figures           a close-up on a figure (or `--kind=<marker kind>`), front by default:
 *                       `--figure=<n|text>`, `--view=front|back|left|right`, `--distance=`, `--lift=`, `--isolate`.
 *     figures-live      let the figures live `--ticks=N` (default 6000) at the simulator's full speed, a tile every
 *                       `--strip=N` ticks (default 600) from a high three-quarter view; the JSON says how far each
 *                       figure walked and how many left their spawn.
 *     ride              stand beside the first coaster car, two static shots `--ride-wait=ms` apart (the car moved),
 *                       then board it by a TAP (the simulator's tap step) and ride `--ticks=N` (default 1200) with the
 *                       script's own rider camera as the client draws it (package B: eased, lagged, animated), a tile every `--strip=N` (default 60).
 *     drive             the pack's scripted vehicle (`--vehicle=<typeId>`, default the first). With `--obstacle=<lane>`
 *                       (step1 hill kerb2 wall3 tree angled pit2 pit3 oblique) the simulator's OWN course step
 *                       (`stuckCourse`) runs while the walk draws it: the child seated, the stick forward into the
 *                       obstacle, the chase camera as vehicle-camera.js asks for it; its course row is the JSON.
 *                       Without it: a HOLD mounts the vehicle where it stands and W is held `--ticks=N` (default 300).
 *     fly               a HOLD mounts the ship and the spaceship controls are pressed in `--sequence=` phases of
 *                       `--phase=N` ticks (default 60): up (Jump), hover (nothing), forward (W), back (S), down
 *                       (S + Jump), left/right (A/D); the JSON gives the ship's rise and run per phase.
 *     doors             a moving part (`--door=<n|text>`) shot closed from `--distance=` out along its normal
 *                       (`--side=front|back`), opened by the simulator's tap on it, shot open, then the child is put
 *                       1.6 blocks out and walks at it for `--ticks=N` (default 60) with Sneak `--sneak=on|off`
 *                       (the phone's toggle); the JSON says whether the feet crossed the leaf plane and what the
 *                       invariants said.
 *     pinball           a HOLD boards the console, the stick is pulled back a second and let go (the pack's plunger),
 *                       a strip of the game, the ball's position per tile.
 *   --size=<pct>, --turn=0|90|180|270: place at that size and turn first.
 *   --url=<base>: the dev server to drive (default http://localhost:4000). A worktree's own
 *       `bun dev:web -- --port N --strictPort` renders ITS code.
 *   --hide-panels: hide the HUD panels (default on for strips; `--panels` keeps them).
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) flags.set(m[1], m[2]);
  else if (a.startsWith('--')) flags.set(a.slice(2), '');
  else positional.push(a);
}
const [packPath, outPath, layersArg, modeArg] = positional;
if (!packPath || !outPath) {
  console.error('usage: node scripts/_shoot_addon_walk.mjs <pack.mcaddon> <out.png> [layers] [flyout|figures|figures-live|ride|drive|fly|doors|pinball] [--flags]');
  process.exit(64);
}
const MODES = ['flyout', 'figures', 'figures-live', 'ride', 'drive', 'fly', 'doors', 'pinball'];
const mode = MODES.includes(modeArg) ? modeArg : 'flyout';
const wanted = layersArg ? layersArg.split(',').map(s => s.trim()).filter(Boolean) : null;
mkdirSync(outPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
const withSuffix = (p, suffix) => p.replace(/(\.[^./\\]+)$/, `.${suffix}$1`);
const num = (name, dflt) => (flags.has(name) ? Number(flags.get(name)) : dflt);

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

const baseUrl = (flags.get('url') ?? process.env.CRAFTMATIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
await page.goto(`${baseUrl}/?tab=lego`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#lego-addon-walk-file', { state: 'attached', timeout: 30000 });
await page.setInputFiles('#lego-addon-walk-file', resolve(packPath));
await page.waitForSelector('.ap-tog', { timeout: 120000 });

// ─── Helpers over the DEV hook (`window.__addonWalk`) ────────────────────────

/** Wait until the simulator placed the pack and a frame arrived. */
async function waitReady(timeoutMs = 240000) {
  await page.waitForFunction(() => { const w = window.__addonWalk; return !!(w && w.simClient.info && w.simClient.frame); }, null, { timeout: timeoutMs });
  await page.waitForTimeout(300);
}
const readTick = () => page.evaluate(() => window.__addonWalk?.simClient.frame?.tick ?? 0);
/** Wait until the simulator's tick reaches `target` (the walk runs it at 20 Hz; a fast-forward runs faster). */
async function waitTick(target, timeoutMs = 120000) {
  await page.waitForFunction(t => (window.__addonWalk?.simClient.frame?.tick ?? 0) >= t, target, { timeout: timeoutMs });
}
const readState = () => page.evaluate(() => {
  const w = window.__addonWalk;
  const f = w?.simClient.frame;
  const rows = [...document.querySelectorAll('.ap-tog[data-act="show"]')].map(e => `${e.dataset.kind}:${e.getAttribute('aria-pressed') === 'true' ? 'on' : 'off'}`);
  return {
    title: document.querySelector('.ap-title')?.textContent?.trim().slice(0, 120) ?? '',
    layers: rows,
    hint: document.querySelector('.ap-hint')?.textContent?.trim() ?? '',
    tick: f?.tick ?? null,
    player: f ? { x: f.player.x, y: f.player.y, z: f.player.z, yaw: f.player.yaw, pitch: f.player.pitch, riding: f.player.riding, onGround: f.player.onGround, slot: f.player.slot } : null,
    camera: f?.camera ?? null,
    // What the phone's client draws (package B): the eased / animated script camera, or the own view from the drawn seat.
    drawn: f?.drawn ?? null,
    client: w?.simClient.info?.client ?? null,
    aim: f?.aim ?? null,
    anchor: w?.anchorPoint ?? null,
    hooks: w?.simClient.info?.hooks ?? null,
    inline: w?.simClient.info?.inline ?? null,
    entities: f?.entities.length ?? 0,
    violations: w ? w.violationList.map(v => `${v.invariant}@${v.tick}: ${v.message.slice(0, 160)}`) : [],
    lines: w ? w.allLines.map(l => `${l.tick} ${l.kind} ${l.text.slice(0, 140)}`) : [],
    unmodelled: f?.unmodelled ?? [],
    stepRunning: f?.step ?? null,
    blocks: w?.colliderStats ?? null,
  };
});
/** The simulator entity (pose) of the first holder of a kind, or by type. */
const findEntity = (sel) => page.evaluate((sel) => {
  const w = window.__addonWalk;
  const f = w.simClient.frame;
  const kindOf = id => w.entityHolders.get(id)?.kind ?? null;
  const list = f.entities.filter(e => (sel.typeId ? e.typeId === sel.typeId : true) && (sel.kind ? kindOf(e.id) === sel.kind : true) && (sel.text ? (w.previewModel.entities.find(a => a.typeId === e.typeId)?.label ?? e.typeId).includes(sel.text) : true));
  const e = list[sel.index ?? 0];
  if (!e) return null;
  const b = w.holderBounds(e.id);
  const a = w.anchorPoint;
  return { id: e.id, typeId: e.typeId, kind: kindOf(e.id), label: w.previewModel.entities.find(x => x.typeId === e.typeId)?.label ?? e.typeId, x: e.x - a.x, y: e.y - a.y, z: e.z - a.z, yaw: e.yaw, riding: e.riding, bounds: b ? { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } } : null, count: list.length };
}, sel);
/** Free-fly the camera to a pin-frame point looking at another. */
const lookFrom = (eye, at) => page.evaluate(({ eye, at }) => {
  const w = window.__addonWalk;
  const dx = at.x - eye.x, dy = at.y - eye.y, dz = at.z - eye.z;
  const yaw = Math.atan2(-dx, dz) * 180 / Math.PI, pitch = Math.atan2(-dy, Math.hypot(dx, dz)) * 180 / Math.PI;
  w.flyTo(eye.x, eye.y, eye.z, yaw, pitch);
  return { yaw, pitch };
}, { eye, at });
/** Frame a pin-frame box from a three-quarter (or named) view. */
async function frameBox(b, view = 'three-quarter', distance = 0, lift = 0) {
  const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
  const span = { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
  const d = distance > 0 ? distance : Math.max(span.x, span.y, span.z, 1) * 1.35;
  const dir = view === 'front' ? { x: 0, z: 1 } : view === 'back' ? { x: 0, z: -1 } : view === 'left' ? { x: 1, z: 0 } : view === 'right' ? { x: -1, z: 0 } : view === 'top' ? { x: 0.01, z: 0.01 } : { x: Math.SQRT1_2, z: Math.SQRT1_2 };
  const up = view === 'top' ? d : view === 'three-quarter' ? Math.max(0.5, span.y * 0.35) + d * 0.45 : Math.max(0.5, span.y * 0.35);
  const eye = { x: c.x + dir.x * d, y: c.y + up + lift, z: c.z + dir.z * d };
  const look = await lookFrom(eye, c);
  await page.waitForTimeout(250);
  return { center: c, span, distance: d, eye, ...look };
}
const hidePanels = async () => { await page.evaluate(() => { window.__addonWalk.hidePanels(); const r = document.querySelector('[data-act="reach"]'); if (r instanceof HTMLElement && r.getAttribute('aria-pressed') === 'true') r.click(); }); };
/** A facing yaw/pitch toward a holder's drawn centre from an eye in front of it. */
const bedrockYawToward = (from, to) => Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI;

/** The walk's own box on the page: every shot is clipped to it (the tab's side panel is not evidence). */
let clip = null;
const viewClip = async () => { clip = await page.evaluate(() => window.__addonWalk.viewRect); return clip; };
const shot = async (path) => page.screenshot({ type: 'png', ...(clip ? { clip } : {}), ...(path ? { path } : {}) });
/** A tile for a strip: the screenshot, stamped. */
const shots = [];
async function tile(label) {
  const png = await shot();
  shots.push({ png, label });
}
/** Write the strip: tiles stamped with their labels in rows, never 2000 px wide or tall (more columns, smaller tiles, as the count grows). */
async function writeStrip(path) {
  if (!shots.length) return null;
  const aspect = clip ? clip.height / clip.width : 860 / 1280;
  let cols = 4;
  while (cols < 8 && Math.ceil(shots.length / cols) * Math.round(Math.floor(1920 / cols) * aspect) >= 1990) cols++;
  const w = Math.floor(1920 / cols), h = Math.round(w * aspect);
  const tiles = await Promise.all(shots.map(async s => {
    const svg = Buffer.from(`<svg width="${w}" height="${h}"><rect x="4" y="4" width="${Math.min(w - 8, 12 + s.label.length * 7.5)}" height="20" rx="4" fill="rgba(0,0,0,0.65)"/><text x="10" y="18" font-family="monospace" font-size="13" fill="#fff">${s.label.replace(/[<&>]/g, '')}</text></svg>`);
    return sharp(s.png).resize(w, h).composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer();
  }));
  const rows = Math.ceil(tiles.length / cols);
  await sharp({ create: { width: w * Math.min(cols, tiles.length), height: h * rows, channels: 3, background: '#000000' } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * w, top: Math.floor(i / cols) * h }))).png().toFile(path);
  return { path, tiles: tiles.length, cols, width: w * Math.min(cols, tiles.length), height: h * rows };
}
/** Hold the walk's keys for `ticks` simulator ticks, taking a tile every `every` ticks (0: none). */
async function holdFor(codes, ticks, every, labelPrefix) {
  const start = await readTick();
  for (const c of codes) await page.keyboard.down(c);
  try {
    if (every > 0) {
      for (let t = every; t <= ticks; t += every) { await waitTick(start + t); await tile(`${labelPrefix} t+${t}`); }
    } else await waitTick(start + ticks);
  } finally { for (const c of codes) await page.keyboard.up(c); }
  return (await readTick()) - start;
}
const finish = async (json) => {
  const out = { pack: packPath, mode, out: outPath, ...json, errors: errors.slice(0, 8) };
  writeFileSync(withSuffix(outPath, 'json').replace(/\.png$/, ''), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
};

// ─── Common set-up: layers, size, turn, wait for the simulator ───────────────

await waitReady();
if (wanted) {
  // Each legend row has a show/hide toggle keyed by `data-kind`; re-query before every click (the HUD re-renders).
  const kinds = await page.$$eval('.ap-tog[data-act="show"]', els => els.map(e => ({ kind: e.dataset.kind, on: e.getAttribute('aria-pressed') === 'true' })));
  for (const { kind, on } of kinds) {
    if (on !== wanted.includes(kind)) { await page.click(`.ap-tog[data-act="show"][data-kind="${kind}"]`); await page.waitForTimeout(120); }
  }
}
for (const [name, act] of [['size', 'size'], ['turn', 'turn']]) {
  if (!flags.has(name)) continue;
  const clicked = await page.evaluate(({ act, v }) => { const b = document.querySelector(`.ap-tog[data-act="${act}"][data-${act}="${v}"]`); if (b instanceof HTMLElement) { b.click(); return true; } return false; }, { act, v: flags.get(name) });
  if (!clicked) { console.error(`--${name}=${flags.get(name)}: no such step on this pack`); process.exit(64); }
  await page.waitForTimeout(500);
  await waitReady();
}
if (!flags.has('panels')) await hidePanels();
await page.waitForTimeout(400);
await viewClip();
const stripEvery = num('strip', 0);

// ─── Modes ───────────────────────────────────────────────────────────────────

if (mode === 'flyout') {
  const b = await page.evaluate(() => {
    const w = window.__addonWalk;
    let box = null;
    for (const [id] of w.entityHolders) { const hb = w.holderBounds(id); if (!hb) continue; box = box ? { min: { x: Math.min(box.min.x, hb.min.x), y: Math.min(box.min.y, hb.min.y), z: Math.min(box.min.z, hb.min.z) }, max: { x: Math.max(box.max.x, hb.max.x), y: Math.max(box.max.y, hb.max.y), z: Math.max(box.max.z, hb.max.z) } } : { min: { ...hb.min }, max: { ...hb.max } }; }
    return box;
  });
  const framed = b ? await frameBox(b, 'three-quarter') : null;
  await page.waitForTimeout(800);
  await shot(outPath);
  await finish({ framed, ...(await readState()) });
} else if (mode === 'figures') {
  const which = flags.get('figure') ?? '0';
  const kind = flags.get('kind') ?? 'figure';
  const sel = /^\d+$/.test(which) ? { kind: kind === 'appearance' ? undefined : kind, index: Number(which) } : { kind: kind === 'appearance' ? undefined : kind, text: which };
  const e = await findEntity(sel);
  if (!e || !e.bounds) { await shot(outPath); await finish({ placed: { ok: false, reason: `no ${kind} "${which}" with drawn geometry (${e?.count ?? 0} of that kind)` } }); process.exit(1); }
  if (flags.has('isolate')) await page.evaluate(id => window.__addonWalk.isolate([id]), e.id);
  const view = ['back', 'left', 'right', 'front'].includes(flags.get('view')) ? flags.get('view') : 'front';
  // A figure's or a car's geometry faces the opposite way to a shell's root frame: "front" stands where its face is.
  const c = { x: (e.bounds.min.x + e.bounds.max.x) / 2, y: (e.bounds.min.y + e.bounds.max.y) / 2, z: (e.bounds.min.z + e.bounds.max.z) / 2 };
  const span = Math.max(e.bounds.max.x - e.bounds.min.x, e.bounds.max.y - e.bounds.min.y, e.bounds.max.z - e.bounds.min.z);
  const d = num('distance', 0) > 0 ? num('distance', 0) : span * 1.35;
  const yawRad = e.yaw * Math.PI / 180;
  const facing = { x: -Math.sin(yawRad), z: Math.cos(yawRad) };
  const around = view === 'front' ? 1 : view === 'back' ? -1 : 0;
  const side = view === 'left' ? 1 : view === 'right' ? -1 : 0;
  const eye = { x: c.x + facing.x * d * around + facing.z * d * side, y: c.y + Math.max(0.3, span * 0.2) + num('lift', 0), z: c.z + facing.z * d * around - facing.x * d * side };
  const look = await lookFrom(eye, c);
  await page.waitForTimeout(500);
  await shot(outPath);
  await finish({ placed: { ok: true, ...e, view, distance: d, eye, ...look, hasRealGeometry: true }, state: await readState() });
} else if (mode === 'figures-live') {
  const ticks = num('ticks', 6000), every = stripEvery || 600;
  // Frame the FIGURES (where they stand, with room to walk), not the whole model: a bank's tower would shrink them to pixels.
  const all = await page.evaluate(() => {
    const w = window.__addonWalk, a = w.anchorPoint;
    let box = null;
    for (const e of w.simClient.frame.entities) {
      if (w.entityHolders.get(e.id)?.kind !== 'figure') continue;
      const p = { x: e.x - a.x, y: e.y - a.y, z: e.z - a.z };
      box = box ? { min: { x: Math.min(box.min.x, p.x), y: Math.min(box.min.y, p.y), z: Math.min(box.min.z, p.z) }, max: { x: Math.max(box.max.x, p.x), y: Math.max(box.max.y, p.y), z: Math.max(box.max.z, p.z) } } : { min: { ...p }, max: { ...p } };
    }
    if (!box) return null;
    return { min: { x: box.min.x - 4, y: box.min.y, z: box.min.z - 4 }, max: { x: box.max.x + 4, y: box.max.y + 2, z: box.max.z + 4 } };
  });
  const framed = all ? await frameBox(all, 'three-quarter', Math.max(all.max.x - all.min.x, all.max.z - all.min.z) * 0.8, 3) : null;
  const figuresAt = () => page.evaluate(() => { const w = window.__addonWalk, a = w.anchorPoint; return w.simClient.frame.entities.filter(e => w.entityHolders.get(e.id)?.kind === 'figure').map(e => ({ id: e.id, typeId: e.typeId, x: e.x - a.x, y: e.y - a.y, z: e.z - a.z, riding: e.riding })); });
  const start = await figuresAt();
  const t0 = await readTick();
  await tile(`t ${t0}`);
  const maxFrom = new Map(start.map(f => [f.id, 0]));
  const quiet = new Map(start.map(f => [f.id, 0]));
  for (let t = every; t <= ticks; t += every) {
    await page.evaluate(n => window.__addonWalk.simClient.fastForward(n, n), every);
    await waitTick(t0 + t, 600000);
    await page.waitForTimeout(150);
    await tile(`t ${t0 + t} (+${t})`);
    const now = await figuresAt();
    for (const f of now) { const s = start.find(x => x.id === f.id); if (!s) continue; const d = Math.hypot(f.x - s.x, f.z - s.z); maxFrom.set(f.id, Math.max(maxFrom.get(f.id) ?? 0, d)); }
  }
  const end = await figuresAt();
  const figures = start.map(s => { const e = end.find(x => x.id === s.id); return { typeId: s.typeId, start: { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) }, end: e ? { x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2), riding: e.riding } : null, maxFromStart: +((maxFrom.get(s.id) ?? 0).toFixed(2)) }; });
  const strip = await writeStrip(outPath);
  await finish({ framed, ticks, every, strip, figures, walked: figures.filter(f => f.maxFromStart > 1).length, seated: end.filter(f => f.riding).length, state: await readState() });
} else if (mode === 'ride') {
  const rideWaitMs = num('ride-wait', 2500), ticks = num('ticks', 1200), every = stripEvery || 60;
  const car = await findEntity({ kind: 'car' });
  if (!car) { await shot(outPath); await finish({ placed: { ok: false, reason: 'no coaster car in the simulator' } }); process.exit(1); }
  await lookFrom({ x: car.x - 5, y: car.y + 2.5, z: car.z - 5 }, { x: car.x, y: car.y + 0.5, z: car.z });
  await page.waitForTimeout(300);
  await shot(outPath);
  const before = { x: car.x, y: car.y, z: car.z, yaw: car.yaw, tick: await readTick() };
  await page.waitForTimeout(rideWaitMs);
  const after = await findEntity({ typeId: car.typeId, index: 0 });
  const movedPath = withSuffix(outPath, 'moved');
  await shot(movedPath);
  const moved = after ? Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) : null;
  // Board as the device does: the car is a native rideable (family player, interact_text "Ride the coaster"), so a
  // HOLD mounts it - while it DWELLS at the station (a moving car is out of reach by the time the hold lands).
  // Wait for any car to stand still, then the simulator's hold step stands the child within reach and interacts.
  await page.evaluate(() => window.__addonWalk.setFly(false));
  const carsAt = () => page.evaluate(() => { const w = window.__addonWalk; return w.simClient.frame.entities.filter(e => w.entityHolders.get(e.id)?.kind === 'car').map(e => ({ id: e.id, typeId: e.typeId, x: e.x, y: e.y, z: e.z })); });
  let dwelling = null, prev = await carsAt();
  for (let i = 0; i < 400 && !dwelling; i++) {
    await page.waitForTimeout(250);
    const now = await carsAt();
    dwelling = now.find(c => { const p = prev.find(x => x.id === c.id); return p && Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) < 0.005; }) ?? null;
    prev = now;
  }
  const holdResult = dwelling ? await page.evaluate(t => window.__addonWalk.simClient.runStep({ kind: 'hold', label: 'hold the car' }, { typeId: t }), dwelling.typeId) : { ok: false, error: 'no car dwelt at the station within 100 s' };
  await page.waitForTimeout(600);
  const boardedAt = await readTick();
  let boarded = await readState();
  const t0 = await readTick();
  await tile(`boarded t ${t0}`);
  for (let t = every; t <= ticks; t += every) { await waitTick(t0 + t); await tile(`ride t+${t}`); }
  const strip = await writeStrip(withSuffix(outPath, 'strip'));
  boarded = await readState();
  await finish({ car, before, after, movedDistanceBlocks: moved, movedPath, dwelling, holdResult, boardedAt, riding: boarded.player?.riding ?? null, camera: boarded.camera, strip, state: boarded });
} else if (mode === 'drive') {
  const info = await page.evaluate(() => window.__addonWalk.simClient.info);
  const type = flags.get('vehicle') ?? info.vehicleTypes.find(t => !info.nativeMountTypes.includes(t)) ?? info.vehicleTypes[0];
  if (!type) { await shot(outPath); await finish({ placed: { ok: false, reason: 'the pack declares no scripted vehicle' } }); process.exit(1); }
  const every = stripEvery || 10;
  const obstacle = flags.get('obstacle');
  await page.evaluate(() => window.__addonWalk.setFly(false));
  if (obstacle) {
    // The simulator's own course lane, drawn: the step spawns the vehicle on the lane, seats the child, holds the stick.
    const t0 = await readTick();
    const done = page.evaluate(({ type, obstacle }) => window.__addonWalk.simClient.runStep({ kind: 'stuckCourse', label: `course ${obstacle}`, type, obstacles: [obstacle], trace: 4 }), { type, obstacle });
    let settled = false;
    done.then(() => { settled = true; });
    await page.waitForTimeout(400);
    await tile(`${obstacle} t ${await readTick()}`);
    for (let t = every; !settled && t <= 2000; t += every) {
      const target = t0 + t;
      await Promise.race([waitTick(target).catch(() => {}), done]);
      if (settled) break;
      await tile(`${obstacle} t+${t}`);
    }
    const result = await done;
    await tile(`${obstacle} end t ${await readTick()}`);
    const strip = await writeStrip(withSuffix(outPath, 'strip'));
    await shot(outPath);
    await finish({ vehicle: type, obstacle, course: result.state?.course ?? null, stepOk: result.ok, stepError: result.error ?? null, notes: result.notes, strip, state: await readState() });
  } else {
    const ticks = num('ticks', 300);
    const hold = await page.evaluate(t => window.__addonWalk.simClient.runStep({ kind: 'hold', label: 'mount' }, { typeId: t }), type);
    await page.waitForTimeout(400);
    const mounted = await readState();
    const t0 = await readTick();
    await tile(`mounted t ${t0}`);
    await holdFor(['KeyW'], ticks, every, 'W');
    await tile(`released t ${await readTick()}`);
    // Hotbar 9: the cockpit view at speed, drawn raw, while W is held again briefly.
    await page.evaluate(() => window.__addonWalk.selectSlot(8));
    await holdFor(['KeyW'], 40, 0, 'W');
    await tile(`cockpit (slot 9) t ${await readTick()}`);
    const cockpit = await readState();
    await shot(withSuffix(outPath, 'cockpit'));
    const strip = await writeStrip(withSuffix(outPath, 'strip'));
    await shot(outPath);
    await finish({ vehicle: type, hold, riding: mounted.player?.riding ?? null, cockpit: { camera: cockpit.camera, player: cockpit.player }, strip, state: await readState() });
  }
} else if (mode === 'fly') {
  const info = await page.evaluate(() => window.__addonWalk.simClient.info);
  const type = flags.get('vehicle') ?? info.vehicleTypes.find(t => !info.nativeMountTypes.includes(t)) ?? info.vehicleTypes[0];
  if (!type) { await shot(outPath); await finish({ placed: { ok: false, reason: 'the pack declares no scripted vehicle' } }); process.exit(1); }
  const phases = (flags.get('sequence') ?? 'up,hover,forward,back,down').split(',').map(s => s.trim()).filter(Boolean);
  const phaseTicks = num('phase', 60), every = stripEvery || 20;
  const KEYS = { up: ['Space'], hover: [], forward: ['KeyW'], back: ['KeyS'], down: ['KeyS', 'Space'], left: ['KeyA'], right: ['KeyD'] };
  await page.evaluate(() => window.__addonWalk.setFly(false));
  const hold = await page.evaluate(t => window.__addonWalk.simClient.runStep({ kind: 'hold', label: 'mount' }, { typeId: t }), type);
  await page.waitForTimeout(400);
  const vehicleAt = () => page.evaluate(() => { const w = window.__addonWalk, f = w.simClient.frame, a = w.anchorPoint; const v = f.entities.find(e => e.id === f.player.riding); return v ? { x: +(v.x - a.x).toFixed(2), y: +(v.y - a.y).toFixed(2), z: +(v.z - a.z).toFixed(2), yaw: +v.yaw.toFixed(1) } : null; });
  const mounted = await readState();
  await tile(`mounted t ${await readTick()}`);
  const results = [];
  for (const ph of phases) {
    const codes = KEYS[ph];
    if (!codes) { results.push({ phase: ph, error: 'unknown phase' }); continue; }
    const from = await vehicleAt();
    const t0 = await readTick();
    await holdFor(codes, phaseTicks, every, ph);
    const to = await vehicleAt();
    results.push({ phase: ph, ticks: (await readTick()) - t0, from, to, rise: from && to ? +(to.y - from.y).toFixed(2) : null, run: from && to ? +Math.hypot(to.x - from.x, to.z - from.z).toFixed(2) : null, turned: from && to ? +(((to.yaw - from.yaw + 540) % 360) - 180).toFixed(1) : null });
  }
  // Hotbar 9: the cockpit view the pack's vehicle-camera.js asks for, drawn raw (the seat's eye; package B adds the client's lag).
  await page.evaluate(() => window.__addonWalk.selectSlot(8));
  await waitTick((await readTick()) + 30);
  await tile(`cockpit (slot 9) t ${await readTick()}`);
  const cockpit = await readState();
  await shot(withSuffix(outPath, 'cockpit'));
  const strip = await writeStrip(withSuffix(outPath, 'strip'));
  await shot(outPath);
  await finish({ vehicle: type, hold, riding: mounted.player?.riding ?? null, phases: results, cockpit: { camera: cockpit.camera, player: cockpit.player }, strip, state: await readState() });
} else if (mode === 'doors') {
  const which = flags.get('door') ?? '0';
  const distance = num('distance', 3.2), side = flags.get('side') === 'back' ? -1 : 1, elev = num('elev', 1.2), ticks = num('ticks', 60), every = stripEvery || 10;
  const frame = await page.evaluate(({ which, distance, side, elev }) => {
    const w = window.__addonWalk, m = w.previewModel, cfg = m.interactives;
    if (!cfg) return { ok: false, reason: 'this pack ships no moving parts (no scripts/interactives.js)' };
    const index = /^\d+$/.test(which) ? Number(which) : cfg.items.findIndex(it => it.label.includes(which));
    const item = cfg.items[index];
    if (!item) return { ok: false, reason: `no moving part "${which}" (${cfg.items.length} in the pack)` };
    const actor = m.entities.find(e => e.interactive === index);
    const sim = actor ? w.simClient.frame.entities.find(e => e.typeId === actor.typeId) : null;
    if (!actor || !sim) return { ok: false, reason: 'the simulator has no entity for that part' };
    const a = w.anchorPoint, at = { x: sim.x - a.x, y: sim.y - a.y, z: sim.z - a.z };
    const r = w.view.rotation, n = item.normal ?? [0, 0, 1];
    const turn = (x, z) => r === 90 ? { x: -z, z: x } : r === 180 ? { x: -x, z: -z } : r === 270 ? { x: z, z: -x } : { x, z };
    const nn = turn(n[0], n[2]), nl = Math.hypot(nn.x, nn.z) || 1;
    const f = Math.max(1, w.view.sizePct / 100);
    return { ok: true, index, label: item.label, kind: item.kind, opening: item.opening, passSize: item.passSize, typeId: actor.typeId, at, normal: { x: nn.x / nl * side, z: nn.z / nl * side }, f, distance, elev };
  }, { which, distance, side, elev });
  if (!frame.ok) { await shot(outPath); await finish({ placed: frame }); process.exit(1); }
  // Where a child stands to tap it: the simulator's own approach (its `tap` step stands the child where a tap picks the
  // leaf and looks at it) - the closed shot is that first-person view. The part may refuse that first spot ("behind a
  // wall"); the doorway lines below retry from others, as child-play does.
  await page.evaluate(() => window.__addonWalk.setFly(false));
  const tapResult = await page.evaluate(t => window.__addonWalk.simClient.runStep({ kind: 'tap', label: 'tap the part', expectHit: false }, { typeId: t }), frame.typeId);
  await page.waitForTimeout(300);
  const spot = (await readState()).player;
  const partProps = () => page.evaluate(id => { const w = window.__addonWalk; const e = w.simClient.frame.entities.find(x => x.typeId === id); return e ? (w.simClient.propsOf(e.id) ?? e.props ?? null) : null; }, frame.typeId);
  const afterTap = await partProps();
  if (afterTap && Math.abs(afterTap['craftmatic:angle'] ?? 0) > 1) {
    // The tap opened it: tap again so the closed shot is of the closed leaf.
    await page.evaluate(t => window.__addonWalk.simClient.runStep({ kind: 'tap', label: 'close it again', expectHit: false }, { typeId: t }), frame.typeId);
    await waitTick((await readTick()) + 30);
  }
  await shot(outPath);
  await tile(`closed t ${await readTick()}`);
  // DOOR-01's own check: the adapter's doorway lines (tap the leaf from up to four spots until it opens, the pair too,
  // then the device's straight walks through from both sides, a fall or a stop attributed) - drawn while it runs.
  const t0 = await readTick();
  const linesDone = page.evaluate(i => window.__addonWalk.simClient.runStep({ kind: 'doorwayLines', label: 'doorway lines', only: [i] }), frame.index);
  let settled = false;
  linesDone.then(() => { settled = true; });
  for (let t = every * 3; !settled && t <= 4000; t += every * 3) { await Promise.race([waitTick(t0 + t).catch(() => {}), linesDone]); if (settled) break; await tile(`lines t+${t}`); }
  const lines = await linesDone;
  // Back at the tapping spot for the open shot.
  if (spot) await page.evaluate(({ spot }) => window.__addonWalk.simClient.teleport({ x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, pitch: spot.pitch, fly: false }), { spot });
  await waitTick((await readTick()) + 6);
  const openPath = withSuffix(outPath, 'open');
  await shot(openPath);
  await tile(`open t ${await readTick()}`);
  const openState = await partProps();
  const eye = spot ? { x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, pitch: spot.pitch } : null;
  const look = {};
  // The walk: the child from where it tapped (a legal standing spot the simulator chose, never a blind point inside a
  // collider), W held toward the leaf, Sneak as asked (the phone's toggle).
  const a0 = (await readState()).anchor;
  const start = spot ? { x: spot.x - a0.x, y: spot.y - a0.y, z: spot.z - a0.z } : { x: frame.at.x + frame.normal.x * 1.6 * frame.f, y: frame.at.y + 0.1, z: frame.at.z + frame.normal.z * 1.6 * frame.f };
  const yaw = bedrockYawToward(start, frame.at);
  const violationsBefore = (await readState()).violations.length;
  await page.evaluate(({ start, yaw, sneak }) => { const w = window.__addonWalk, a = w.anchorPoint; w.setFly(false); w.sneakToggle(sneak); w.simClient.teleport({ x: start.x + a.x, y: start.y + a.y, z: start.z + a.z, yaw, pitch: 10, fly: false }); }, { start, yaw, sneak: (flags.get('sneak') ?? 'off') === 'on' });
  await page.waitForTimeout(300);
  const walkStart = (await readState()).player;
  await holdFor(['KeyW'], ticks, every, 'W');
  await page.waitForTimeout(200);
  const endState = await readState();
  const a = endState.anchor;
  const end = endState.player ? { x: endState.player.x - a.x, y: endState.player.y - a.y, z: endState.player.z - a.z } : null;
  const crossed = end ? -((end.x - frame.at.x) * frame.normal.x + (end.z - frame.at.z) * frame.normal.z) : null;
  const throughPath = withSuffix(outPath, 'through');
  await shot(throughPath);
  await tile(`walked t ${await readTick()}`);
  const strip = await writeStrip(withSuffix(outPath, 'strip'));
  await finish({ placed: { ...frame, eye, ...look }, tapResult, doorwayLines: { ok: lines.ok, error: lines.error ?? null, notes: lines.notes, findings: lines.state?.doorwayFindings ?? null }, openProps: openState, openPath, throughPath, strip, walk: { start: walkStart ? { x: walkStart.x - a.x, y: walkStart.y - a.y, z: walkStart.z - a.z } : null, end, crossedBlocks: crossed === null ? null : +crossed.toFixed(2), through: crossed !== null && crossed > 0.5, sneak: flags.get('sneak') ?? 'off' }, violationsDuringWalk: endState.violations.slice(violationsBefore), state: endState });
} else if (mode === 'pinball') {
  const consoleType = await page.evaluate(() => window.__addonWalk.previewModel.pinball?.consoleType ?? null);
  if (!consoleType) { await shot(outPath); await finish({ placed: { ok: false, reason: 'this pack has no playable pinball table (no scripts/pinball.js)' } }); process.exit(1); }
  const ticks = num('ticks', 200), every = stripEvery || 20;
  await page.evaluate(() => window.__addonWalk.setFly(false));
  const hold = await page.evaluate(t => window.__addonWalk.simClient.runStep({ kind: 'hold', label: 'board the console' }, { typeId: t }), consoleType);
  await page.waitForTimeout(500);
  const boarded = await readState();
  await shot(outPath);
  await tile(`boarded t ${await readTick()}`);
  // The pack's plunger: the stick pulled back a second and let go (bedrock-pinball.ts), then the game runs.
  await holdFor(['KeyS'], 20, 0, 'pull');
  const ballAt = () => page.evaluate(() => { const w = window.__addonWalk, pb = w.previewModel.pinball, a = w.anchorPoint; const e = w.simClient.frame.entities.find(x => x.typeId === pb.ballType); return e ? { x: +(e.x - a.x).toFixed(2), y: +(e.y - a.y).toFixed(2), z: +(e.z - a.z).toFixed(2), props: w.simClient.propsOf(e.id) ?? null } : null; });
  const ballBefore = await ballAt();
  const t0 = await readTick();
  const balls = [];
  for (let t = every; t <= ticks; t += every) { await waitTick(t0 + t); await tile(`play t+${t}`); balls.push(await ballAt()); }
  const strip = await writeStrip(withSuffix(outPath, 'strip'));
  await finish({ consoleType, hold, riding: boarded.player?.riding ?? null, camera: boarded.camera, ballBefore, balls, strip, state: await readState() });
}
