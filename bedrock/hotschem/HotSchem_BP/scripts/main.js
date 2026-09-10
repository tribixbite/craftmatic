import { world, system, BlockPermutation, BlockVolume, ItemStack, StructureSaveMode, MolangVariableMap } from '@minecraft/server';
import { ActionFormData, ModalFormData } from '@minecraft/server-ui';
import MODELS from './library.js';
import { acceptPart, decodeModelJob } from './live-import.js';
const imports = new Map();
const streaming = new Map(), streamBusy = new Set();
import { sizeOf, rotate, transform, split, tileKey, volume } from './placement-geometry.js';
import { restorePlan, selectModel, setScale, setOrigin, planBounds, dimensions, previewPoints, SCALES } from './plan.js';
const states = new Map(), previews = new Map(), choosing = new Set();
let active, importLoading = true;
const wait = ticks => new Promise(resolve => system.runTimeout(resolve, ticks));
const tell = (p, text) => { try { p.sendMessage({ text: `§b[HotSchem]§r ${text}` }); } catch {} };
// Form rendering on retail Android strips percent signs; spell out the unit in forms.
function form() {
  const f = new ActionFormData();
  return { title(text) { f.title({ text: text.replaceAll("%", " percent") }); return this; }, body(text) { f.body({ text: text.replaceAll("%", " percent") }); return this; }, button(text) { f.button({ text: text.replaceAll("%", " percent") }); return this; }, show(p) { return f.show(p); } };
}
function state(p) {
  if (!states.has(p.id)) { let raw; try { raw = JSON.parse(p.getDynamicProperty('hotschem:plan') || 'null'); } catch {} states.set(p.id, restorePlan(raw, MODELS)); }
  return states.get(p.id);
}
function persist(p) { p.setDynamicProperty('hotschem:plan', JSON.stringify(state(p))); }
function bounds(s) { return planBounds(s, MODELS); }
function problem(p, s = state(p)) { try { validate(p, s); return ''; } catch (e) { return e.message; } }
function summary(p) { const s = state(p), m = MODELS[s.key]; return `${Math.round(s.scale * 100)}% · ${dimensions(sizeOf(m, s.rotation, s.scale))} blocks · ${s.rotation}°\nOrigin: ${s.anchor ? `${s.anchor.x}, ${s.anchor.y}, ${s.anchor.z}` : 'not set'}\n${problem(p) || 'Ready to place'}`; }
function validate(p, s) {
  if (!s.anchor) throw new Error('Set a build origin in Location first.');
  if (!MODELS[s.key] || ![0, 90, 180, 270].includes(s.rotation) || ![.25, .5, 1, 2].includes(s.scale) || ![0, 1].includes(s.mode)) throw new Error('Choose a valid schematic, rotation, size and mode.');
  if (!Object.values(s.anchor).every(n => Number.isSafeInteger(n) && Math.abs(n) < 30000000)) throw new Error('Enter valid whole-number coordinates.');
  if (s.dimension !== p.dimension.id) throw new Error('Origin is in another dimension. Set a new location.');
  const b = bounds(s), range = p.dimension.heightRange;
  if (b.from.y < range.min || b.to.y >= range.max) throw new Error(`Build needs Y ${b.from.y}–${b.to.y}. Use a smaller size or a lower position (world Y ${range.min}–${range.max - 1}).`);
  if (volume(b) > 80000000) throw new Error('Build area is too large. Choose a smaller size.');
  return b;
}
function preview(p, announce = true) {
  const s = state(p);
  if (!s.anchor) return locationMenu(p);
  s.preview = true; persist(p); previews.delete(p.id);
  drawPreview(p);
  if (announce) tell(p, `${s.scale * 100}% · ${dimensions(sizeOf(MODELS[s.key], s.rotation, s.scale))} · Origin ${s.anchor.x}, ${s.anchor.y}, ${s.anchor.z}.\nOutline ON. Use the Planner to adjust or hide it.`);
}
function drawPreview(p) {
  if (importLoading) return;
  const s = state(p); if (!s.preview || !s.key || !s.anchor || active) return;
  if (s.dimension !== p.dimension.id) { p.onScreenDisplay.setActionBar('Preview is in another dimension. Planner > Location'); return; }
  const b = bounds(s), range = p.dimension.heightRange, m = MODELS[s.key], issue = problem(p);
  const color = new MolangVariableMap(); color.setColorRGB('variable.color', issue ? { red: 1, green: .15, blue: .2 } : s.mode ? { red: 1, green: .55, blue: .1 } : { red: .1, green: 1, blue: .8 });
  const near = point => Math.hypot(point.x - p.location.x, point.y - p.location.y, point.z - p.location.z) < 60;
  let sent = 0, failure;
  const emit = point => {
    if (point.y < range.min || point.y >= range.max || !near(point)) return;
    try { p.spawnParticle('hotschem:guide', point, color); sent++; } catch (e) { failure = e; }
  };
  for (const point of previewPoints(b, p.location)) emit(point);
  for (let i = 0; i < m.samples.length; i += 3) {
    const [x, z] = rotate(m.samples[i], m.samples[i + 2], m, s.rotation);
    emit({ x: s.anchor.x + x * s.scale + .5, y: s.anchor.y + m.samples[i + 1] * s.scale + .5, z: s.anchor.z + z * s.scale + .5 });
  }
  const distance = Math.round(Math.hypot(s.anchor.x - p.location.x, s.anchor.z - p.location.z));
  p.onScreenDisplay.setActionBar(`PREVIEW ${s.scale * 100}% · ${dimensions(sizeOf(m, s.rotation, s.scale))} · Origin ${distance}m away${issue ? ' · ' + issue : !sent ? ' · Move closer to the outline' : ''}`);
  if (failure && !sent && !previews.has(p.id)) { tell(p, `Preview could not render here: ${failure.message}. Move closer to the origin; check that HotSchem resources are active.`); previews.set(p.id, true); }
}
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    if (choosing.has(p.id)) p.onScreenDisplay.setActionBar('SET ORIGIN: tap a ground block with the Planner · Sneak + use to cancel');
    else safe(p, () => drawPreview(p));
  }
}, 10);
async function load(dim, b) {
  const ta = world.tickingAreaManager, id = 'hotschem_work';
  if (ta.hasTickingArea(id)) ta.removeTickingArea(id);
  const options = { dimension: dim, from: { x: b.from.x, y: 0, z: b.from.z }, to: { x: b.to.x, y: 0, z: b.to.z } };
  if (!ta.hasCapacity(options)) throw new Error('No chunk-loading capacity available. Try again after other builds finish.');
  await ta.createTickingArea(id, options);
}
function unload() { try { const ta = world.tickingAreaManager; if (ta.hasTickingArea('hotschem_work')) ta.removeTickingArea('hotschem_work'); } catch {} }
function run(generator) { return new Promise((resolve, reject) => system.runJob((function* () { try { resolve(yield* generator); } catch (e) { reject(e); } })())); }
function history(p) { try { return JSON.parse(p.getDynamicProperty('hotschem:undo') || 'null'); } catch { return null; } }
function saveHistory(p, h) { p.setDynamicProperty('hotschem:undo', h ? JSON.stringify(h) : undefined); }
function discard(h) { if (h) for (let i = 0; i < h.count; i++) world.structureManager.delete(`${h.id}_${i}`); }
function palette(m, rotation) {
  return m.palette.map(([name, original]) => {
    const states = { ...original };
    for (const key of ['minecraft:cardinal_direction', 'cardinal_direction']) if (key in states) { const a = ['north', 'east', 'south', 'west'], i = a.indexOf(states[key]); if (i >= 0) states[key] = a[(i + rotation / 90) % 4]; }
    if (rotation % 180 && ['x', 'z'].includes(states.pillar_axis)) states.pillar_axis = states.pillar_axis === 'x' ? 'z' : 'x';
    if ('weirdo_direction' in states) { const seq = [3, 0, 2, 1], i = seq.indexOf(states.weirdo_direction); if (i >= 0) states.weirdo_direction = seq[(i + rotation / 90) % 4]; }
    if ('facing_direction' in states) { const seq = [2, 5, 3, 4], i = seq.indexOf(states.facing_direction); if (i >= 0) states.facing_direction = seq[(i + rotation / 90) % 4]; }
    if ('direction' in states) states.direction = (states.direction + rotation / 90) % 4;
    if ('ground_sign_direction' in states) states.ground_sign_direction = (states.ground_sign_direction + rotation / 90 * 4) % 16;
    try { return BlockPermutation.resolve(name, states); }
    catch (error) { if (name === 'minecraft:chain') return BlockPermutation.resolve('minecraft:iron_chain', states); throw error; }
  });
}
async function place(p) {
  if (active) return tell(p, 'A build or undo is already running.');
  const s = structuredState(state(p)), m = MODELS[s.key], b = validate(p, s), dim = p.dimension;
  const perms = palette(m, s.rotation), air = BlockPermutation.resolve('minecraft:air');
  active = { player: p.id, cancelled: false }; const task = active, started = Date.now(); state(p).preview = false; persist(p); previews.delete(p.id);
  let h;
  try {
    // Build geographic buckets before any mutation. Splitting handles cuboids crossing tile boundaries.
    const tiles = new Map();
    for (const piece of split(b)) { const key = tileKey(piece); if (!tiles.has(key)) tiles.set(key, { backups: [], ops: [] }); tiles.get(key).backups.push(piece); }
    await run((function* () { for (const op of m.ops) { for (const piece of split(transform(op, m, s.rotation, s.scale, s.anchor))) tiles.get(tileKey(piece)).ops.push(piece); yield; } })());
    discard(history(p));
    h = { id: `hotschem:u${Date.now().toString(36)}`, title: m.title, dimension: dim.id, bounds: b, count: 0, complete: false };
    saveHistory(p, h);
    let done = 0, fills = 0, written = 0;
    for (const tile of tiles.values()) {
      if (task.cancelled) throw new Error('Cancelled. Undo restores the area already changed.');
      await load(dim, { from: tile.backups[0].from, to: tile.backups[0].to });
      for (const piece of tile.backups) {
        world.structureManager.createFromWorld(`${h.id}_${h.count}`, dim, piece.from, piece.to, { includeEntities: false, saveMode: StructureSaveMode.World });
        h.count++; saveHistory(p, h); // Record each backup before modifying its blocks.
        if (s.mode === 1) { dim.fillBlocks(new BlockVolume(piece.from, piece.to), air); }
        await wait(1);
      }
      await run((function* () { for (const piece of tile.ops) {
        if (task.cancelled) throw new Error('Cancelled. Undo restores the area already changed.');
        const result = dim.fillBlocks(new BlockVolume(piece.from, piece.to), perms[piece.palette]);
        fills++; written += result.getCapacity(); yield;
      } })());
      done++; tell(p, `${Math.round(done / tiles.size * 100)}% · ${done}/${tiles.size} areas`);
      unload();
    }
    h.complete = true; saveHistory(p, h);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    tell(p, `§aPlaced ${m.title} in ${seconds}s. ${fills.toLocaleString()} fills. Use Undo to restore the previous blocks.`);
    console.warn(`HOTSCHEM_PLACED ${JSON.stringify({ title: m.title, seconds, fills, written, tiles: tiles.size, bounds: b, clear: s.mode === 1 })}`);
    p.setDynamicProperty('hotschem:last_result', JSON.stringify({ title: m.title, seconds, fills, bounds: b, success: true }));
  } catch (e) { tell(p, `§cPlacement stopped: ${e.message || e}`); console.warn(`HOTSCHEM_FAILED ${e.stack || e}`); }
  finally { unload(); active = undefined; }
}
function structuredState(s) { return { ...s, anchor: s.anchor && { ...s.anchor } }; }
async function undo(p) {
  if (active) return tell(p, 'Wait for the current job or cancel it first.');
  const h = history(p); if (!h) return tell(p, 'Nothing to undo.');
  active = { player: p.id }; const dim = world.getDimension(h.dimension);
  try {
    let index = 0, loadedTile;
    for (const piece of split(h.bounds)) {
      if (index >= h.count) break;
      const key = tileKey(piece);
      if (key !== loadedTile) { await load(dim, piece); loadedTile = key; }
      world.structureManager.place(`${h.id}_${index}`, dim, piece.from, { includeEntities: false, includeBlocks: true });
      index++; await wait(1);
    }
    discard(h); saveHistory(p, null); tell(p, '§aUndo complete. Previous blocks restored.'); console.warn('HOTSCHEM_UNDO_OK');
  } catch (e) { tell(p, `Undo stopped: ${e.message}. Backup retained; retry Undo.`); }
  finally { unload(); active = undefined; }
}
async function library(p, query = '', page = 0) {
  if (importLoading) return tell(p, 'Loading saved imports. Open the Planner again in a moment.');
  const keys = Object.keys(MODELS).filter(k => MODELS[k].title.toLowerCase().includes(query.toLowerCase()));
  const pageKeys = keys.slice(page * 8, page * 8 + 8);
  const f = form().title('HotSchem · Library').body(`${keys.length} schematics · Page ${page + 1}\nChoose a build to preview.`);
  pageKeys.forEach(k => { const m = MODELS[k]; f.button(`${m.title}\n${m.w} × ${m.h} × ${m.l}`); });
  const actions = [];
  if ((page + 1) * 8 < keys.length) { f.button('Next page →'); actions.push(() => library(p, query, page + 1)); }
  if (page) { f.button('← Previous page'); actions.push(() => library(p, query, page - 1)); }
  f.button('Search'); actions.push(async () => { const r = await new ModalFormData().title('Search schematics').textField('File name or model number', '43222').show(p); if (!r.canceled) return library(p, String(r.formValues[0] || '')); });
  f.button('Import · paste local file'); actions.push(() => importMenu(p));
  f.button('Undo last placement'); actions.push(() => undoForm(p));
  const r = await f.show(p); if (r.canceled) return;
  if (r.selection < pageKeys.length) { const s = state(p); selectModel(s, pageKeys[r.selection]); persist(p); if (s.anchor) preview(p, false); return modelMenu(p); }
  return actions[r.selection - pageKeys.length]?.();
}
// Finished imports are shared by players in this world and loaded before plans.
function importedIndex() { return JSON.parse(world.getDynamicProperty('hotschem:imports') || '[]'); }
function storeImport(id, encoded) {
  const index = importedIndex(), key = `live_${id}`;
  if (index.some(e => e.key === key)) return key;
  if (index.length >= 16 || index.reduce((n, e) => n + e.size, 0) + encoded.length > 8 * 1048576) throw Error('Saved import library is full. Remove an imported model first.');
  const count = Math.ceil(encoded.length / 28000);
  try {
    for (let i = 0; i < count; i++) world.setDynamicProperty(`hotschem:${key}_${i}`, encoded.slice(i * 28000, (i + 1) * 28000));
    world.setDynamicProperty('hotschem:imports', JSON.stringify([...index, { key, count, size: encoded.length }]));
  } catch (e) { for (let i = 0; i < count; i++) world.setDynamicProperty(`hotschem:${key}_${i}`, undefined); throw e; }
  return key;
}
world.afterEvents.worldLoad.subscribe(() => {
  let entries; try { entries = importedIndex(); } catch (error) { importLoading = false; console.warn(error.message); return; }
  run((function* () {
    for (const e of entries) {
      try { let encoded = ''; for (let i = 0; i < e.count; i++) { encoded += world.getDynamicProperty(`hotschem:${e.key}_${i}`) || ''; yield; } MODELS[e.key] = yield* decodeModelJob(encoded); }
      catch (error) { console.warn(`HotSchem saved import ${e.key}: ${error.message}`); }
      yield;
    }
  })()).catch(error => console.warn(`HotSchem imports: ${error.message}`)).finally(() => { importLoading = false; });
});
async function importMenu(p) {
  const pending = imports.get(p.id);
  const r = await form().title('Import local build').body('Open HotSchem-Importer.html in a browser, choose a Craftmatic .mcpack or Sponge .schem, then use Live import. Copy each part and paste it here. No server or world restart is needed after HotSchem is active on the host.\n\n' + (pending ? `${pending.parts.size}/${pending.count} parts received. You can close this menu and resume.` : 'Import adds a model to the library. It does not place blocks. Large builds may need many parts.'))
    .button(pending ? 'Paste next part' : 'Paste import code').button('Discard unfinished transfer').button('Manage saved imports').button('Back to library').show(p);
  if (r.canceled) return;
  if (r.selection === 0) return pasteImport(p);
  if (r.selection === 1) { imports.delete(p.id); return importMenu(p); }
  if (r.selection === 2) return manageImports(p);
  return library(p);
}
async function pasteImport(p) {
  const pending = imports.get(p.id); let next = 1; while (pending?.parts.has(next)) next++;
  const r = await new ModalFormData().title('HotSchem · Paste import').textField(pending ? `Paste part ${next} of ${pending.count}` : 'Paste part 1 from the offline importer', 'HS1:...').submitButton('Read part').show(p);
  if (r.canceled) return;
  try {
    const result = acceptPart(pending, String(r.formValues[0] || ''), true);
    imports.set(p.id, result.session);
    if (!result.encoded) { tell(p, `${result.session.parts.size}/${result.session.count} parts received.`); return pasteImport(p); }
    tell(p, 'All parts received. Preparing the model…');
    result.model = await run(decodeModelJob(result.encoded));
    palette(result.model, 0); // Validate materials before publishing this library entry.
    const key = storeImport(result.session.id, result.encoded);
    MODELS[key] = result.model; imports.delete(p.id);
    const s = state(p); selectModel(s, key); persist(p); if (s.anchor) preview(p, false);
    tell(p, `Imported ${result.model.title}. Saved in this world's library. Set Location and review before placing.`);
    return modelMenu(p);
  } catch (error) { tell(p, error.message + ' If Minecraft truncated the paste, discard this transfer and choose smaller parts in the browser.'); return importMenu(p); }
}
async function manageImports(p) {
  const entries = importedIndex();
  const f = form().title('Saved imports').body('Remove a model from the shared library to free space. Placed builds and Undo remain.');
  for (const e of entries) f.button(MODELS[e.key]?.title || e.key);
  f.button('Back'); const r = await f.show(p); if (r.canceled) return;
  if (r.selection >= entries.length) return importMenu(p);
  const entry = entries[r.selection];
  const q = await form().title('Remove imported model?').body(MODELS[entry.key]?.title || entry.key).button('Remove from library').button('Keep').show(p);
  if (!q.canceled && q.selection === 0) {
    if (active) throw Error('Wait until the current build finishes.');
    world.setDynamicProperty('hotschem:imports', JSON.stringify(importedIndex().filter(e => e.key !== entry.key)));
    for (let i = 0; i < entry.count; i++) world.setDynamicProperty(`hotschem:${entry.key}_${i}`, undefined);
    delete MODELS[entry.key];
    for (const [id, s] of states) if (s.key === entry.key) { s.key = Object.keys(MODELS)[0]; s.preview = false; previews.delete(id); }
  }
  return manageImports(p);
}
async function modelMenu(p) {
  if (importLoading) return tell(p, 'Loading saved imports. Open the Planner again in a moment.');
  if (active) return progress(p);
  if (!state(p).key) return library(p);
  const s = state(p), m = MODELS[s.key];
  const f = form().title('HotSchem · Plan build').body(`${m.title}\n${summary(p)}\nChanges apply to your next placement.`)
    .button('Location · choose / move origin').button(`Size · ${s.scale * 100}%`).button(`Rotation · ${s.rotation}°`).button(s.preview ? 'Preview ON · view / hide' : 'Preview OFF · view / hide').button(s.mode ? 'Replace mode · clear entire box' : 'Replace mode · occupied blocks only').button('§aReview & place').button('Undo last placement').button('Choose another schematic');
  const r = await f.show(p); if (r.canceled) return;
  if (r.selection === 0) return locationMenu(p);
  if (r.selection === 1) return sizeMenu(p);
  if (r.selection === 2) return rotationMenu(p);
  if (r.selection === 3) return previewMenu(p);
  if (r.selection === 4) { s.mode = s.mode ? 0 : 1; persist(p); return modelMenu(p); }
  if (r.selection === 5) {
    const issue = problem(p); if (issue) { tell(p, issue); return modelMenu(p); }
    const b = bounds(s);
    const q = await form().title('Confirm placement').body(`${m.title}\n${summary(p)}\nTo: ${b.to.x}, ${b.to.y}, ${b.to.z}\n${s.mode ? 'Clears EVERY block inside the box, including schematic air spaces.' : 'Replaces occupied schematic cells. Empty spaces stay unchanged.'}\nUndo restores previous blocks. This replaces your previous Undo. Mobs stay.`).button('§aPlace this build').button('Back to plan').show(p);
    if (!q.canceled && q.selection === 0) return place(p); return modelMenu(p);
  }
  if (r.selection === 6) return undoForm(p);
  return library(p);
}
async function previewMenu(p) {
  const s = state(p);
  const r = await form().title('Preview outline').body('Appears immediately: bright origin column, ground outline and dotted build detail. This is not a solid ghost model.\nStays on until hidden or placed. Large builds show nearby portions; walk around to inspect them.').button('View preview now').button('Hide preview').button('Back to plan').show(p);
  if (r.canceled) return;
  if (r.selection === 0) return preview(p);
  if (r.selection === 1) { s.preview = false; persist(p); p.onScreenDisplay.setActionBar('Preview hidden'); }
  return modelMenu(p);
}
async function locationMenu(p) {
  const s = state(p);
  const r = await form().title('Location · build origin').body(`Origin: ${s.anchor ? Object.values(s.anchor).join(', ') : 'not set'}\nBottom North-West corner. Build extends East (+X), South (+Z), and up. Moves the preview only.`)
    .button('Tap a ground block to set origin').button('Set origin at my feet').button('Enter exact X / Y / Z').button('Nudge origin by blocks').button('Back to plan').show(p);
  if (r.canceled) return;
  if (r.selection === 0) { choosing.add(p.id); tell(p, 'Tap a ground block with the Planner. Its top becomes the build origin. Sneak + use cancels.'); return; }
  if (r.selection === 1) { setOrigin(s, { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) }, p.dimension.id); return preview(p); }
  if (r.selection === 2) return coordinatesMenu(p);
  if (r.selection === 3) return nudgeMenu(p);
  return modelMenu(p);
}
async function coordinatesMenu(p) {
  const s = state(p), a = s.anchor || { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) };
  const r = await new ModalFormData().title('Set bottom corner · X / Y / Z').textField('X · East / West', 'whole number', { defaultValue: String(a.x) }).textField('Y · bottom layer of the build', 'whole number', { defaultValue: String(a.y) }).textField('Z · South / North', 'whole number', { defaultValue: String(a.z) }).submitButton('Save origin & show preview').show(p);
  if (r.canceled) return;
  const v = r.formValues.map(x => String(x).trim());
  if (v.some(x => !/^-?\d+$/.test(x))) { tell(p, 'Enter three whole numbers; no blank fields. Origin unchanged.'); return coordinatesMenu(p); }
  setOrigin(s, { x: Number(v[0]), y: Number(v[1]), z: Number(v[2]) }, p.dimension.id); return preview(p);
}
async function sizeMenu(p) {
  const s = state(p), m = MODELS[s.key];
  const f = form().title('Size · next placement').body(`Current: ${s.scale * 100}% · ${dimensions(sizeOf(m, s.rotation, s.scale))}\nTap to save. 50% halves every dimension. Smaller builds lose detail; existing builds do not resize.`);
  for (const scale of SCALES) f.button(`${scale === s.scale ? '✓ ' : ''}${scale * 100}%${scale === 1 ? ' · original' : ''}\n${dimensions(sizeOf(m, s.rotation, scale))} blocks`);
  f.button('Back to plan'); const r = await f.show(p); if (r.canceled) return;
  if (r.selection < SCALES.length) { setScale(s, SCALES[r.selection]); persist(p); if (s.anchor) preview(p, false); tell(p, `Size saved: ${s.scale * 100}% · ${dimensions(sizeOf(m, s.rotation, s.scale))}. Applies to the next placement.`); }
  return modelMenu(p);
}
async function rotationMenu(p) {
  const s = state(p), f = form().title('Rotation · next placement').body('Rotates the build inside its box. The bottom corner stays fixed.');
  for (const r of [0, 90, 180, 270]) f.button(`${r === s.rotation ? '✓ ' : ''}${r}°`);
  f.button('Back to plan'); const result = await f.show(p); if (result.canceled) return;
  if (result.selection < 4) { s.rotation = result.selection * 90; persist(p); if (s.anchor) preview(p, false); }
  return modelMenu(p);
}
async function nudgeMenu(p) {
  const s = state(p); if (!s.anchor) { tell(p, 'Set an origin first.'); return locationMenu(p); }
  const f = form().title('Move preview origin').body(`${summary(p)}\nStep: ${s.step} block(s). Existing builds stay put.`);
  const moves = [['East +X', 'x', 1], ['West −X', 'x', -1], ['South +Z', 'z', 1], ['North −Z', 'z', -1], ['Up +Y', 'y', 1], ['Down −Y', 'y', -1]];
  moves.forEach(([label]) => f.button(label)); f.button(`Step: ${s.step} · switch to ${s.step === 1 ? 10 : 1}`).button('Done · view preview').button('Back to plan');
  const r = await f.show(p); if (r.canceled) return;
  if (r.selection < 6) { const [, axis, sign] = moves[r.selection]; setOrigin(s, { ...s.anchor, [axis]: s.anchor[axis] + sign * s.step }, s.dimension); preview(p, false); return nudgeMenu(p); }
  if (r.selection === 6) { s.step = s.step === 1 ? 10 : 1; persist(p); return nudgeMenu(p); }
  if (r.selection === 7) return preview(p);
  return modelMenu(p);
}
async function undoForm(p) { const h = history(p); if (!h) return tell(p, 'Nothing to undo.'); const r = await form().title('Restore previous blocks?').body(`Undo ${h.title}. Any newer changes inside its build area will also be replaced by the backup.`).button('Restore blocks').button('Back').show(p); if (!r.canceled && r.selection === 0) return undo(p); }
async function progress(p) { const r = await form().title('Build in progress').body('You can close this menu and keep playing. Progress appears in chat.').button('Keep building').button('Cancel build').show(p); if (!r.canceled && r.selection === 1 && active?.player === p.id) active.cancelled = true; }
function safe(p, fn) { Promise.resolve().then(fn).catch(e => tell(p, e.message || String(e))); }
const lastOpen = new Map();
function openPlanner(p) { if (choosing.has(p.id)) { if (p.isSneaking) { choosing.delete(p.id); tell(p, 'Origin selection cancelled.'); } else tell(p, 'Tap a ground block to set the origin.'); return; } if (system.currentTick - (lastOpen.get(p.id) ?? -100) < 8) return; lastOpen.set(p.id, system.currentTick); safe(p, () => modelMenu(p)); }
function give(p) { const inv = p.getComponent('minecraft:inventory')?.container; if (!inv) return; for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === 'hotschem:planner') return; inv.addItem(new ItemStack('hotschem:planner')); tell(p, 'Use the HotSchem Planner to choose a schematic.'); }
world.afterEvents.playerSpawn.subscribe(ev => { if (ev.initialSpawn) system.runTimeout(() => safe(ev.player, () => give(ev.player)), 40); });
world.afterEvents.itemUse.subscribe(ev => { if (ev.itemStack.typeId === 'hotschem:planner') system.run(() => openPlanner(ev.source)); });
world.beforeEvents.playerInteractWithBlock.subscribe(ev => { if (ev.itemStack?.typeId === 'hotschem:planner') { ev.cancel = true; const loc = { ...ev.block.location }; system.run(() => { const p = ev.player; if (choosing.has(p.id) && !p.isSneaking) { choosing.delete(p.id); lastOpen.set(p.id, system.currentTick); safe(p, () => { setOrigin(state(p), { x: loc.x, y: loc.y + 1, z: loc.z }, p.dimension.id); return preview(p); }); } else openPlanner(p); }); } });
system.afterEvents.scriptEventReceive.subscribe(ev => {
  const p = ev.sourceEntity; if (p?.typeId !== 'minecraft:player') return;
  system.run(() => safe(p, async () => {
    if (ev.id === 'hotschem:stream') return receiveStream(p, ev.message);
    if (ev.id === 'hotschem:probe') { p.addTag('hs_stream_v1'); return; }
    if (ev.id === 'hotschem:import') return importMenu(p);
    if (ev.id === 'hotschem:menu') return library(p);
    if (ev.id === 'hotschem:plan') { const v = ev.message.split(' '), s = state(p); const key = Object.keys(MODELS).find(k => MODELS[k].title.startsWith(v[0])); if (!key) throw new Error('Unknown model'); selectModel(s, key); if (v.length >= 4) setOrigin(s, { x: Number(v[1]), y: Number(v[2]), z: Number(v[3]) }, p.dimension.id); persist(p); return modelMenu(p); }
    if (ev.id === 'hotschem:kit') return give(p);
    if (ev.id === 'hotschem:undo') return undo(p);
    // Explicit developer trigger for repeatable device validation; never runs on join.
    if (ev.id === 'hotschem:test') { const v = ev.message.split(' '), s = state(p); const key = Object.keys(MODELS).find(k => MODELS[k].title.startsWith(v[0])); if (!key) throw new Error('Unknown model'); Object.assign(s, { key, anchor: { x: Number(v[1]), y: Number(v[2]), z: Number(v[3]) }, dimension: p.dimension.id, scale: Number(v[4] || 1), rotation: Number(v[5] || 0), mode: Number(v[6] || 0) }); return place(p); }
  }));
});
async function receiveStream(p, message) {
  const id = /^HS1:([a-f0-9]{8}):/.exec(message)?.[1];
  if (!id || message.length > 400 || importLoading) return;
  const ready = `hs_ready_${id}`, failed = `hs_error_${id}`;
  if (p.hasTag(ready) || streamBusy.has(p.id)) return;
  try {
    const old = streaming.get(p.id);
    const pending = old && system.currentTick - old.tick < 12000 && old.session.id === id ? old.session : undefined;
    const result = acceptPart(pending, message, true);
    streaming.set(p.id, { session: result.session, tick: system.currentTick });
    if (!result.encoded) return;
    streamBusy.add(p.id);
    const model = await run(decodeModelJob(result.encoded));
    palette(model, 0);
    const key = storeImport(id, result.encoded);
    MODELS[key] = model;
    const s = state(p); selectModel(s, key); persist(p);
    for (const tag of p.getTags()) if (/^hs_(ready|error)_[a-f0-9]{8}$/.test(tag)) p.removeTag(tag);
    p.addTag(ready);
    tell(p, `Received ${model.title} from Craftmatic. Open the Planner to preview and place.`);
    streaming.delete(p.id);
  } catch (error) {
    streaming.delete(p.id); p.addTag(failed); tell(p, `Transfer failed: ${error.message}`);
  } finally { streamBusy.delete(p.id); }
}
system.runInterval(() => { for (const [id, value] of streaming) if (system.currentTick - value.tick > 12000) streaming.delete(id); }, 1200);
console.warn(`HOTSCHEM_READY ${Object.keys(MODELS).length} models`);
