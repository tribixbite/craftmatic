declare const world: any;
declare const system: any;
declare const StructureSaveMode: any;
declare const ActionFormData: any;
declare const ModalFormData: any;

export type PlacementRotation = 0 | 90 | 180 | 270;

export interface PlacementActor {
  typeId: string;
  label: string;
  x: number; y: number; z: number;
  yaw?: number;
}

export interface PlacementPackSpec {
  stem: string;
  label: string;
  width: number; height: number; length: number;
  tiles: PlacementTile[];
  actors?: PlacementActor[];
  /** Sparse non-air model points used to make rotation obvious in preview. */
  previewPoints?: Array<{ x: number; y: number; z: number }>;
}

export interface PlacementPackAssets {
  itemId: string;
  shortAlias: string;
  script: string;
  files: Array<{ name: string; data: Uint8Array }>;
}

export interface PlacementTile {
  identifier: string;
  dx: number; dy: number; dz: number;
  width: number; height: number; length: number;
  nonAir: number;
}

export interface RotatedTilePlacement extends PlacementTile {
  width: number;
  length: number;
}

/** Short deterministic command name; the full per-model alias also remains available. */
export function placementAlias(stem: string): string {
  if (/76252/.test(stem)) return 'b76252';
  if (/8855/.test(stem)) return 'b8855';
  let hash = 0x811c9dc5;
  for (const ch of `craftmatic.brickwand:${stem}`) hash = Math.imul((hash ^ ch.charCodeAt(0)) >>> 0, 0x01000193) >>> 0;
  return `b_${hash.toString(16).padStart(8, '0').slice(0, 6)}`;
}

export function rotatedSize(width: number, height: number, length: number, rotation: PlacementRotation) {
  return rotation % 180 ? { width: length, height, length: width } : { width, height, length };
}

/** Position a separately rotated tile inside the model's normalized rotated bounds. */
export function rotateTilePlacement(
  tile: PlacementTile, modelWidth: number, modelLength: number, rotation: PlacementRotation,
): RotatedTilePlacement {
  if (rotation === 90) return { ...tile, dx: modelLength - tile.dz - tile.length, dz: tile.dx, width: tile.length, length: tile.width };
  if (rotation === 180) return { ...tile, dx: modelWidth - tile.dx - tile.width, dz: modelLength - tile.dz - tile.length };
  if (rotation === 270) return { ...tile, dx: tile.dz, dz: modelWidth - tile.dx - tile.width, width: tile.length, length: tile.width };
  return { ...tile };
}

/** Rotate an entity/component point with the same normalized transform as the blocks. */
export function rotatePlacementPoint(
  point: { x: number; y: number; z: number }, width: number, length: number, rotation: PlacementRotation,
) {
  if (rotation === 90) return { x: length - point.z, y: point.y, z: point.x };
  if (rotation === 180) return { x: width - point.x, y: point.y, z: length - point.z };
  if (rotation === 270) return { x: point.z, y: point.y, z: width - point.x };
  return { ...point };
}

const enc = new TextEncoder();
const text = (value: string) => enc.encode(value.endsWith('\n') ? value : `${value}\n`);

// Serialized into each generated pack. Keep this function plain JavaScript so
// its toString() output is a valid Bedrock script module after TS transpilation.
function placementRuntime(config: any) {
  const states = new Map(), previews = new Set(), histories = new Map(), held = new Set(), showing = new Set();
  let active: any;
  const rotations = [0, 90, 180, 270];
  const tell = (p: any, s: string) => { try { p.sendMessage(`§b[Brick Wand]§r ${s}`); } catch {} };
  const wait = (ticks: number) => new Promise(resolve => system.runTimeout(resolve, ticks));
  const show = async (p: any, form: any) => {
    if (showing.has(p.id)) return { canceled: true };
    showing.add(p.id);
    try { return await form.show(p); }
    catch (e: any) { tell(p, `Menu unavailable: ${e.message || e}`); return { canceled: true }; }
    finally { showing.delete(p.id); }
  };
  const areaId = `cm_${config.shortAlias}`;
  const unload = () => { try { if (world.tickingAreaManager.hasTickingArea(areaId)) world.tickingAreaManager.removeTickingArea(areaId); } catch {} };
  const load = async (dimension: any, from: any, to: any) => {
    unload();
    const options = { dimension, from: { x: Math.floor(from.x), y: 0, z: Math.floor(from.z) }, to: { x: Math.floor(to.x), y: 0, z: Math.floor(to.z) } };
    if (!world.tickingAreaManager.hasCapacity(options)) throw new Error('No chunk-loading capacity is available. Move closer or try again after another placement finishes.');
    await world.tickingAreaManager.createTickingArea(areaId, options);
  };
  const state = (p: any) => {
    if (!states.has(p.id)) states.set(p.id, { anchor: undefined, dimension: undefined, rotation: 0 });
    return states.get(p.id);
  };
  const size = (r: number) => r % 180
    ? { width: config.length, height: config.height, length: config.width }
    : { width: config.width, height: config.height, length: config.length };
  const tileAt = (t: any, r: number) => {
    if (r === 90) return { ...t, dx: config.length - t.dz - t.length, dz: t.dx, width: t.length, length: t.width };
    if (r === 180) return { ...t, dx: config.width - t.dx - t.width, dz: config.length - t.dz - t.length };
    if (r === 270) return { ...t, dx: t.dz, dz: config.width - t.dx - t.width, width: t.length, length: t.width };
    return { ...t };
  };
  const pointAt = (v: any, r: number) => {
    if (r === 90) return { x: config.length - v.z, y: v.y, z: v.x };
    if (r === 180) return { x: config.width - v.x, y: v.y, z: config.length - v.z };
    if (r === 270) return { x: v.z, y: v.y, z: config.width - v.x };
    return { x: v.x, y: v.y, z: v.z };
  };
  const summary = (s: any) => {
    const d = size(s.rotation);
    return `${d.width} × ${d.height} × ${d.length} blocks · ${s.rotation}°\nOrigin: ${s.anchor ? `${s.anchor.x}, ${s.anchor.y}, ${s.anchor.z} in ${s.dimension}` : 'not pinned'}`;
  };
  const validate = (p: any, s: any) => {
    if (!s.anchor) throw new Error('Pin an origin or enter coordinates first.');
    if (s.dimension !== p.dimension.id) throw new Error(`Origin is pinned in ${s.dimension}. Re-pin after changing dimensions.`);
    const d = size(s.rotation), range = p.dimension.heightRange;
    if (s.anchor.y < range.min || s.anchor.y + d.height - 1 >= range.max) throw new Error(`Build exceeds world height ${range.min}–${range.max - 1}.`);
    return d;
  };
  const outline = (s: any) => {
    const d = size(s.rotation), points = [], step = Math.max(1, Math.ceil(Math.max(d.width, d.height, d.length) / 12));
    for (let x = 0; x <= d.width; x += step) for (const y of [0, d.height]) for (const z of [0, d.length]) points.push({ x: Math.min(x, d.width), y, z });
    for (let y = 0; y <= d.height; y += step) for (const x of [0, d.width]) for (const z of [0, d.length]) points.push({ x, y: Math.min(y, d.height), z });
    for (let z = 0; z <= d.length; z += step) for (const x of [0, d.width]) for (const y of [0, d.height]) points.push({ x, y, z: Math.min(z, d.length) });
    return points.slice(0, 72);
  };
  const draw = (p: any) => {
    const s = state(p); if (!previews.has(p.id) || !s.anchor || active) return;
    if (s.dimension !== p.dimension.id) { p.onScreenDisplay.setActionBar(`PREVIEW PAUSED · origin is in ${s.dimension} · re-pin here`); return; }
    const distance = Math.hypot(s.anchor.x - p.location.x, s.anchor.z - p.location.z);
    p.onScreenDisplay.setActionBar(`PREVIEW · ${config.label} · ${s.rotation}° · ${Math.round(distance)}m away`);
    if (distance > 64) return;
    const points = outline(s);
    for (const sample of config.previewPoints) points.push(pointAt(sample, s.rotation));
    const front = [
      { x: config.width / 2, y: config.height + 1, z: 0 },
      { x: config.width / 2, y: config.height + 1, z: -2 },
      { x: config.width / 2, y: config.height + 1, z: -4 },
      { x: config.width / 2 - 2, y: config.height + 1, z: -2 },
      { x: config.width / 2 + 2, y: config.height + 1, z: -2 },
    ];
    for (const q of front) points.push(pointAt(q, s.rotation));
    for (const q of points.slice(0, 197)) try { p.dimension.spawnParticle('minecraft:basic_flame_particle', { x: s.anchor.x + q.x, y: s.anchor.y + q.y, z: s.anchor.z + q.z }); } catch {}
  };
  system.runInterval(() => { for (const p of world.getAllPlayers()) draw(p); }, 12);
  system.runInterval(() => {
    const online = new Set();
    for (const p of world.getAllPlayers()) {
      online.add(p.id);
      let item: any;
      try { item = p.getComponent('minecraft:inventory')?.container?.getItem(p.selectedSlotIndex); } catch {}
      if (item?.typeId === config.itemId) {
        if (!held.has(p.id)) { held.add(p.id); system.run(() => menu(p).catch((e: any) => tell(p, e.message || String(e)))); }
      } else held.delete(p.id);
    }
    for (const id of held) if (!online.has(id)) held.delete(id);
  }, 5);
  async function edit(p: any): Promise<any> {
    const s = state(p), a = s.anchor || { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) };
    const r = await show(p, new ModalFormData().title(`${config.label} · Coordinates`).textField('X', '0', { defaultValue: String(a.x) }).textField('Y', '64', { defaultValue: String(a.y) }).textField('Z', '0', { defaultValue: String(a.z) }));
    if (r.canceled) return menu(p);
    const values = r.formValues.map((v: any) => Number(v));
    if (!values.every((v: number) => Number.isSafeInteger(v) && Math.abs(v) < 30000000)) { tell(p, 'Use whole-number world coordinates.'); return edit(p); }
    s.anchor = { x: values[0], y: values[1], z: values[2] }; s.dimension = p.dimension.id; previews.add(p.id); return menu(p);
  }
  async function confirmPlace(p: any): Promise<any> {
    const s = state(p); try { validate(p, s); } catch (e: any) { tell(p, e.message); return menu(p); }
    const r = await show(p, new ActionFormData().title(`Place ${config.label}?`).body(`${summary(s)}\n\nBlocks in this area will be replaced.`).button('Place now').button('Back'));
    if (!r.canceled && r.selection === 0) return place(p);
    return menu(p);
  }
  async function place(p: any) {
    if (active) return tell(p, 'Another placement is running.');
    const s = { ...state(p), anchor: { ...state(p).anchor } }, dim = p.dimension;
    validate(p, s); active = { player: p.id, cancelled: false }; previews.delete(p.id);
    const key = `${config.id}_${p.id.replaceAll('-', '').slice(0, 8)}_${Date.now().toString(36)}`, backups: any[] = [], entities: string[] = [];
    try {
      for (let i = 0; i < config.tiles.length; i++) {
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        const t = tileAt(config.tiles[i], s.rotation), from = { x: s.anchor.x + t.dx, y: s.anchor.y + t.dy, z: s.anchor.z + t.dz }, to = { x: from.x + t.width - 1, y: from.y + t.height - 1, z: from.z + t.length - 1 }, name = `craftmatic:${key}_${i}`;
        await load(dim, from, to);
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        world.structureManager.createFromWorld(name, dim, from, to, { includeEntities: false, saveMode: StructureSaveMode.Memory });
        backups.push({ name, from });
        await dim.runCommand(`structure load ${t.identifier} ${from.x} ${from.y} ${from.z} ${s.rotation}_degrees none`);
        tell(p, `${Math.round((i + 1) / Math.max(1, config.tiles.length) * 100)}% · ${i + 1}/${config.tiles.length} structure pieces`); await wait(1);
      }
      for (const actor of config.actors) {
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        const q = pointAt(actor, s.rotation);
        await load(dim, { x: s.anchor.x + q.x - 1, z: s.anchor.z + q.z - 1 }, { x: s.anchor.x + q.x + 1, z: s.anchor.z + q.z + 1 });
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        const entity = dim.spawnEntity(actor.typeId, { x: s.anchor.x + q.x, y: s.anchor.y + q.y, z: s.anchor.z + q.z });
        entity.nameTag = actor.label; entity.setRotation({ x: 0, y: (actor.yaw || 0) + s.rotation }); entities.push(entity.id);
      }
      const old = histories.get(p.id); if (old) for (const b of old.backups) try { world.structureManager.delete(b.name); } catch {}
      histories.set(p.id, { dimension: dim.id, backups, entities });
      tell(p, `§aPlaced ${config.label}. Use the Brick Wand to undo.`);
    } catch (e: any) { histories.set(p.id, { dimension: dim.id, backups, entities }); tell(p, `§cPlacement stopped: ${e.message || e}`); }
    finally { unload(); active = undefined; }
  }
  async function undo(p: any) {
    if (active) return tell(p, 'Wait for placement to finish or cancel it first.');
    const h = histories.get(p.id); if (!h) return tell(p, 'Nothing to undo in this play session.');
    active = { player: p.id, cancelled: false };
    try {
      const dim = world.getDimension(h.dimension);
      for (const id of h.entities) try { world.getEntity(id)?.remove(); } catch {}
      for (const b of h.backups) { const structure = world.structureManager.get(b.name); if (!structure) continue; const to = { x: b.from.x + structure.size.x - 1, y: b.from.y + structure.size.y - 1, z: b.from.z + structure.size.z - 1 }; await load(dim, b.from, to); world.structureManager.place(b.name, dim, b.from, { includeEntities: false, includeBlocks: true }); world.structureManager.delete(b.name); await wait(1); }
      histories.delete(p.id); tell(p, '§aUndo complete.');
    } catch (e: any) { tell(p, `Undo stopped: ${e.message || e}`); }
    finally { unload(); active = undefined; }
  }
  async function menu(p: any): Promise<any> {
    const s = state(p), running = active?.player === p.id;
    const f = new ActionFormData().title(`${config.label} · Brick Wand`).body(`${summary(s)}\n\nPreview first; Place is always a separate confirmation.`);
    if (running) f.button('Cancel placement');
    else f.button('Pin at my feet').button('Edit coordinates').button(`Rotate → ${(s.rotation + 90) % 360}°`).button('View preview in world').button('Place…').button('Undo last placement').button('Hide preview');
    const r = await show(p, f); if (r.canceled) return;
    if (running) { if (active?.player === p.id) active.cancelled = true; return tell(p, 'Cancel requested.'); }
    if (r.selection === 0) { s.anchor = { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) }; s.dimension = p.dimension.id; previews.add(p.id); return menu(p); }
    if (r.selection === 1) return edit(p);
    if (r.selection === 2) { s.rotation = rotations[(rotations.indexOf(s.rotation) + 1) % 4]; if (s.anchor) previews.add(p.id); return menu(p); }
    if (r.selection === 3) { try { validate(p, s); } catch (e: any) { tell(p, e.message); return menu(p); } previews.add(p.id); return tell(p, 'Preview visible. Switch away from the wand and back to rotate or place.'); }
    if (r.selection === 4) return confirmPlace(p);
    if (r.selection === 5) return undo(p);
    if (r.selection === 6) { previews.delete(p.id); return tell(p, 'Preview hidden.'); }
  }
  world.afterEvents.itemUse.subscribe((ev: any) => { if (ev.itemStack.typeId === config.itemId) system.run(() => menu(ev.source).catch((e: any) => tell(ev.source, e.message || String(e)))); });
  console.warn(`BRICK_WAND_READY ${config.id}`);
}

export function buildPlacementPackAssets(spec: PlacementPackSpec): PlacementPackAssets {
  const id = spec.stem.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
  const itemId = `craftmatic:${id}_brick_wand`;
  const shortAlias = placementAlias(spec.stem);
  const config = { id, shortAlias, label: spec.label, itemId, width: spec.width, height: spec.height, length: spec.length, tiles: spec.tiles, actors: spec.actors ?? [], previewPoints: (spec.previewPoints ?? []).slice(0, 120) };
  const script = `import { world, system, StructureSaveMode } from "@minecraft/server";\nimport { ActionFormData, ModalFormData } from "@minecraft/server-ui";\nconst CONFIG = ${JSON.stringify(config)};\n(${placementRuntime.toString()})(CONFIG);\n`;
  const item = {
    format_version: '1.21.30',
    'minecraft:item': {
      description: { identifier: itemId, menu_category: { category: 'items' } },
      components: {
        'minecraft:icon': 'brick',
        'minecraft:display_name': { value: `${spec.label} BrickWand` },
        'minecraft:max_stack_size': 1,
      },
    },
  };
  const grant = `give @s ${itemId} 1\ntellraw @s ${JSON.stringify({ rawtext: [{ text: `§b[BrickWand]§r Select ${spec.label} BrickWand in your hotbar to open it. Switch away and back to reopen.` }] })}\n`;
  return {
    itemId, shortAlias, script,
    files: [
      { name: `items/${id}_brick_wand.json`, data: text(JSON.stringify(item, null, 2)) },
      { name: 'scripts/placement.js', data: text(script) },
      { name: `functions/${shortAlias}.mcfunction`, data: text(grant) },
      { name: `functions/craftmatic/${id}.mcfunction`, data: text(grant) },
    ],
  };
}
