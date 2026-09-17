declare const world: any;
declare const system: any;
declare const StructureSaveMode: any;
declare const BlockPermutation: any;
declare const ActionFormData: any;
declare const ModalFormData: any;

export type PlacementRotation = 0 | 90 | 180 | 270;

export interface PlacementActor {
  typeId: string;
  label: string;
  x: number; y: number; z: number;
  yaw?: number;
  /** Index of another actor this one rides once both are spawned (a figure found sitting on a seat). */
  rideOf?: number;
}

/**
 * In-game size steps (percent of the exported size). Every entity in the pack
 * carries one component group per step (`withSizeGroups`), so the wand can
 * spawn a whole placement at ½× or 2× without re-exporting; the block
 * structure follows only when the pack ships its collider grid (`colliders`).
 */
export const SIZE_STEPS: readonly number[] = [25, 50, 75, 100, 150, 200, 300, 400];
/** `craftmatic:size_<pct>` is both the component group and the event that selects it. */
export const SIZE_EVENT_PREFIX = 'craftmatic:size_';

/** Invisible-collider grid shipped for scripted re-tiling at another size. */
export interface PlacementColliders {
  width: number; height: number; length: number;
  /** The collider block id and its two sixteenth states (bedrock-building-shell.ts). */
  block: string; loState: string; hiState: string;
  /** Run-length cells, x-major `(x*height + y)*length + z` — see `encodeColliderRuns`. */
  runs: string;
  /** Cells that are not colliders (doors, lights); they stay blocks only at 100 %. */
  keptCells: number;
}

export interface PlacementPackSpec {
  stem: string;
  label: string;
  width: number; height: number; length: number;
  tiles: PlacementTile[];
  actors?: PlacementActor[];
  /** Enable controls supplied by the playable DeLorean runtime. */
  vehicleControls?: boolean;
  /** Sparse non-air model points used to make rotation obvious in preview (drawn only when no ghost entity ships). */
  previewPoints?: Array<{ x: number; y: number; z: number }>;
  /** Translucent ghost entity of the whole placement (bedrock-preview-entity.ts); spawned at the pin, turned with the rotation. */
  preview?: { typeId: string };
  /** The collider grid behind the structure tiles, for placement at another size. Absent: the blocks are fixed at 100 %. */
  colliders?: PlacementColliders;
  /**
   * Ticks each tile's ticking area stays alive after its `structure load`, and
   * ticks the last area is held after the final piece. A ticking area removed
   * the moment the command returns can unload the chunk before its block
   * updates reach the client, which read as "nothing appeared until I came back".
   */
  settleTicks?: number;
  finalHoldTicks?: number;
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

// ─── Size groups ─────────────────────────────────────────────────────────────

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** A `minecraft:rideable` component with every seat position (and camera radius) scaled by `f`. */
function scaleRideable(rideable: Record<string, unknown>, f: number): Record<string, unknown> {
  const scaleSeat = (seat: Record<string, unknown>): Record<string, unknown> => ({
    ...seat,
    ...(Array.isArray(seat.position) ? { position: (seat.position as number[]).map(v => round3(v * f)) } : {}),
    ...(typeof seat.third_person_camera_radius === 'number' ? { third_person_camera_radius: round3(seat.third_person_camera_radius * f) } : {}),
  });
  const seats = rideable.seats;
  return {
    ...rideable,
    seats: Array.isArray(seats) ? seats.map(s => scaleSeat(s as Record<string, unknown>)) : seats && typeof seats === 'object' ? scaleSeat(seats as Record<string, unknown>) : seats,
  };
}

/**
 * Give an entity definition one component group per size step, each setting
 * `minecraft:scale`, a collision box scaled to match and (for a mount) its
 * seats scaled too - `minecraft:scale` does not move a rider's seat, so a
 * half-size car would otherwise seat the player at full height. The
 * `craftmatic:size_<pct>` event selects one step and drops the others;
 * `craftmatic:size_100` drops them all. Groups and events the definition
 * already has (an aircraft's descend group) are kept.
 */
export function withSizeGroups(
  behavior: unknown,
  collision: { width: number; height: number },
  rideable?: Record<string, unknown>,
): unknown {
  const b = behavior as { 'minecraft:entity': Record<string, unknown> };
  const e = b['minecraft:entity'];
  const groups: Record<string, unknown> = { ...((e.component_groups as Record<string, unknown> | undefined) ?? {}) };
  const events: Record<string, unknown> = { ...((e.events as Record<string, unknown> | undefined) ?? {}) };
  const names = SIZE_STEPS.filter(p => p !== 100).map(p => `${SIZE_EVENT_PREFIX}${p}`);
  for (const pct of SIZE_STEPS) {
    if (pct === 100) continue;
    const f = pct / 100, name = `${SIZE_EVENT_PREFIX}${pct}`;
    groups[name] = {
      'minecraft:scale': { value: f },
      'minecraft:collision_box': { width: round3(collision.width * f), height: round3(collision.height * f) },
      ...(rideable ? { 'minecraft:rideable': scaleRideable(rideable, f) } : {}),
    };
    events[name] = { remove: { component_groups: names.filter(n => n !== name) }, add: { component_groups: [name] } };
  }
  events[`${SIZE_EVENT_PREFIX}100`] = { remove: { component_groups: names } };
  return { ...b, 'minecraft:entity': { ...e, component_groups: groups, events } };
}

// ─── Collider runs ───────────────────────────────────────────────────────────

/** Sequential index (1..136) of a `(lo, hi)` sixteenth pair with lo < hi; 0 is air. */
export function colliderPairIndex(lo: number, hi: number): number {
  let n = 1;
  for (let l = 0; l < lo; l++) n += 16 - l;
  return n + (hi - lo - 1);
}

/** Inverse of `colliderPairIndex`. */
export function colliderPairOf(index: number): [number, number] {
  let n = 1;
  for (let l = 0; l < 16; l++) {
    const span = 16 - l;
    if (index < n + span) return [l, l + 1 + (index - n)];
    n += span;
  }
  throw new Error(`collider pair index out of range: ${index}`);
}

/** Run-length code: `[valueChar][countChar]` pairs, value 0..136 as char 40+v, count 1..200 as char 40+n−1. */
const RUN_BASE = 40, RUN_MAX = 200;

/**
 * Encode a grid of collider states (`craftmatic:collider[lo=…,hi=…]`) as runs
 * over `(x*height + y)*length + z`. Anything that is not a collider - air, or a
 * scene block such as a door - is 0. Pure and small enough to ship inside the
 * pack's script config (a 60×40×60 castle is a few KB after the air runs).
 */
export function encodeColliderRuns(
  grid: { width: number; height: number; length: number; get(x: number, y: number, z: number): string },
  block: string,
): { runs: string; colliders: number; keptCells: number } {
  const re = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[lo=(\\d+),hi=(\\d+)\\]$`);
  let out = '', prev = -1, count = 0, colliders = 0, keptCells = 0;
  const flush = (): void => {
    while (count > 0) {
      const n = Math.min(RUN_MAX, count);
      out += String.fromCharCode(RUN_BASE + prev) + String.fromCharCode(RUN_BASE + n - 1);
      count -= n;
    }
  };
  for (let x = 0; x < grid.width; x++) for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) {
    const state = grid.get(x, y, z);
    let v = 0;
    const m = re.exec(state);
    if (m) { v = colliderPairIndex(Number(m[1]), Number(m[2])); colliders++; }
    else if (state !== 'minecraft:air') keptCells++;
    if (v === prev) { count++; continue; }
    flush();
    prev = v; count = 1;
  }
  flush();
  return { runs: out, colliders, keptCells };
}

/** Decode runs back to a flat array of pair indices (0 = air). Exported for tests. */
export function decodeColliderRuns(runs: string): Uint8Array {
  const cells: number[] = [];
  for (let k = 0; k + 1 < runs.length; k += 2) {
    const v = runs.charCodeAt(k) - RUN_BASE, n = runs.charCodeAt(k + 1) - RUN_BASE + 1;
    for (let j = 0; j < n; j++) cells.push(v);
  }
  return Uint8Array.from(cells);
}

const enc = new TextEncoder();
const text = (value: string) => enc.encode(value.endsWith('\n') ? value : `${value}\n`);

// Serialized into each generated pack. Keep this function plain JavaScript so
// its toString() output is a valid Bedrock script module after TS transpilation.
function placementRuntime(config: any, openVehicleControls?: (player: any) => Promise<void>) {
  const states = new Map(), previews = new Set(), histories = new Map(), held = new Set(), showing = new Set();
  let active: any;
  const rotations = [0, 90, 180, 270];
  const sizes: number[] = config.sizes && config.sizes.length ? config.sizes : [100];
  const sizeEvent = (pct: number) => `${config.sizeEventPrefix || 'craftmatic:size_'}${pct}`;
  // A pack with no block structure (a vehicle, a figure) may turn in 15° steps; blocks turn by 90°.
  const fineTurn = config.tiles.length === 0;
  const turnStep = fineTurn ? 15 : 90;
  const tell = (p: any, s: string) => { try { p.sendMessage(`§b[Brick Wand]§r ${s}`); } catch {} };
  const wait = (ticks: number) => new Promise(resolve => system.runTimeout(resolve, ticks));
  const show = async (p: any, form: any) => {
    if (showing.has(p.id)) return { canceled: true };
    showing.add(p.id);
    try { return await form.show(p); }
    catch (e: any) { tell(p, `Menu unavailable: ${e.message || e}`); return { canceled: true }; }
    finally { showing.delete(p.id); }
  };
  const areaPrefix = `cm_${config.shortAlias}_${Date.now().toString(36).slice(-4)}`;
  let areaCounter = 0, loadedAreaId: any, loadedDimension: any;
  const unload = async () => {
    const id = loadedAreaId, dimension = loadedDimension;
    loadedAreaId = undefined; loadedDimension = undefined;
    if (!id || !dimension) return;
    try { dimension.runCommand(`tickingarea remove ${id}`); } catch {}
    await wait(2);
  };
  const load = async (dimension: any, from: any, to: any) => {
    await unload();
    const fx = Math.floor(Math.min(from.x, to.x)), fz = Math.floor(Math.min(from.z, to.z));
    const tx = Math.floor(Math.max(from.x, to.x)), tz = Math.floor(Math.max(from.z, to.z));
    const range = dimension.heightRange, y = Math.max(range.min, Math.min(range.max - 1, Math.floor(from.y ?? 0)));
    const areaId = `${areaPrefix}_${++areaCounter}`;
    try {
      const result = dimension.runCommand(`tickingarea add ${fx} ${y} ${fz} ${tx} ${y} ${tz} ${areaId} true`);
      if (result?.successCount === 0) throw new Error('tickingarea command reported successCount 0');
      loadedAreaId = areaId; loadedDimension = dimension;
    }
    catch (e: any) { throw new Error(`Could not preload the build area: ${e.message || e}`); }
    await wait(2);
    const probes = [];
    for (let cx = Math.floor(fx / 16); cx <= Math.floor(tx / 16); cx++) for (let cz = Math.floor(fz / 16); cz <= Math.floor(tz / 16); cz++) {
      probes.push({ x: Math.max(fx, Math.min(tx, cx * 16 + 8)), y, z: Math.max(fz, Math.min(tz, cz * 16 + 8)) });
    }
    let lastFailure = 'no probe result';
    for (let elapsed = 0; elapsed <= 600; elapsed += 2) {
      if (active?.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
      let ready = true;
      for (const q of probes) try {
        if (!dimension.getBlock(q)) { ready = false; lastFailure = `${q.x},${q.y},${q.z} returned undefined`; break; }
      } catch (e: any) {
        ready = false; lastFailure = `${q.x},${q.y},${q.z} threw ${e?.name || 'Error'}: ${e?.message || e}`; break;
      }
      if (ready) return;
      if (elapsed === 600) {
        console.warn(`BRICK_WAND_LOAD_TIMEOUT ${areaId} ${lastFailure}`);
        throw new Error(`Timed out waiting for the build area to load; probe ${lastFailure}. Use Undo to restore any changed area.`);
      }
      await wait(2);
    }
  };
  const state = (p: any) => {
    if (!states.has(p.id)) states.set(p.id, { anchor: undefined, dimension: undefined, rotation: 0, size: 100, aim: false });
    return states.get(p.id);
  };
  const factor = (s: any) => (s.size || 100) / 100;
  // Footprint of the model turned by r: exact swaps at multiples of 90°, the
  // bounding box of the turned rectangle in between (entity-only packs).
  const size = (r: number) => {
    const rr = ((r % 360) + 360) % 360;
    if (rr % 90 === 0) return rr % 180
      ? { width: config.length, height: config.height, length: config.width }
      : { width: config.width, height: config.height, length: config.length };
    const a = rr * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return { width: Math.ceil(config.width * c + config.length * s), height: config.height, length: Math.ceil(config.width * s + config.length * c) };
  };
  // The footprint at the chosen size, in whole blocks.
  const dims = (st: any) => {
    const d = size(st.rotation), f = factor(st);
    return { width: Math.max(1, Math.ceil(d.width * f)), height: Math.max(1, Math.ceil(d.height * f)), length: Math.max(1, Math.ceil(d.length * f)) };
  };
  const tileAt = (t: any, r: number) => {
    if (r === 90) return { ...t, dx: config.length - t.dz - t.length, dz: t.dx, width: t.length, length: t.width };
    if (r === 180) return { ...t, dx: config.width - t.dx - t.width, dz: config.length - t.dz - t.length };
    if (r === 270) return { ...t, dx: t.dz, dz: config.width - t.dx - t.width, width: t.length, length: t.width };
    return { ...t };
  };
  // A model point (blocks from the model's corner) inside the turned footprint.
  const pointAt = (v: any, r: number) => {
    const rr = ((r % 360) + 360) % 360;
    if (rr === 90) return { x: config.length - v.z, y: v.y, z: v.x };
    if (rr === 180) return { x: config.width - v.x, y: v.y, z: config.length - v.z };
    if (rr === 270) return { x: v.z, y: v.y, z: config.width - v.x };
    if (rr === 0) return { x: v.x, y: v.y, z: v.z };
    // Fine turn about the footprint centre, in the world's sense (yaw +90 = the 90° case above).
    const d = size(rr), a = rr * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const px = v.x - config.width / 2, pz = v.z - config.length / 2;
    return { x: d.width / 2 + px * c - pz * s, y: v.y, z: d.length / 2 + px * s + pz * c };
  };
  // World position of a model point for a pinned state (turned, then sized about the pin).
  const worldPoint = (st: any, v: any) => {
    const q = pointAt(v, st.rotation), f = factor(st);
    return { x: st.anchor.x + q.x * f, y: st.anchor.y + q.y * f, z: st.anchor.z + q.z * f };
  };
  // The turned, sized footprint centre relative to the pin.
  const centreOffset = (st: any) => {
    const q = pointAt({ x: config.width / 2, y: 0, z: config.length / 2 }, st.rotation), f = factor(st);
    return { x: q.x * f, z: q.z * f };
  };
  const pinCentredAt = (p: any, st: any, target: any) => {
    const c = centreOffset(st);
    st.anchor = { x: Math.floor(target.x - c.x), y: Math.floor(target.y), z: Math.floor(target.z - c.z) };
    st.dimension = p.dimension.id; previews.add(p.id);
  };
  const blocksResizable = !config.tiles.length || !!config.colliders;
  const summary = (st: any) => {
    const d = dims(st);
    const sizeNote = st.size !== 100 ? ` · ${st.size}%${config.tiles.length && !config.colliders ? ' (blocks stay 100%)' : ''}` : '';
    return `${d.width} × ${d.height} × ${d.length} blocks · ${st.rotation}°${sizeNote}${st.aim ? ' · following your aim' : ''}\nOrigin: ${st.anchor ? `${st.anchor.x}, ${st.anchor.y}, ${st.anchor.z} in ${st.dimension}` : 'not pinned'}`;
  };
  const validate = (p: any, st: any) => {
    if (!st.anchor) throw new Error('Pin an origin, follow your aim or enter coordinates first.');
    if (st.dimension !== p.dimension.id) throw new Error(`Origin is pinned in ${st.dimension}. Re-pin after changing dimensions.`);
    if (st.size !== 100 && !blocksResizable) throw new Error('This pack\'s blocks were exported as coloured blocks and cannot be resized in game. Set the size back to 100%, or export again at another model scale.');
    const d = dims(st), range = p.dimension.heightRange;
    if (st.anchor.y < range.min || st.anchor.y + d.height - 1 >= range.max) throw new Error(`Build exceeds world height ${range.min}–${range.max - 1}.`);
    return d;
  };
  const outline = (d: any) => {
    const points: any[] = [], seen = new Set(), along = (axis: string, fixed: any, end: number) => {
      const count = Math.max(2, Math.min(12, Math.ceil(end / 8) + 1));
      for (let i = 0; i < count; i++) {
        const point = { ...fixed, [axis]: end * i / (count - 1) }, key = `${point.x || 0}:${point.y || 0}:${point.z || 0}`;
        if (!seen.has(key)) { seen.add(key); points.push(point); }
      }
    };
    for (const y of [0, d.height]) for (const z of [0, d.length]) along('x', { y, z }, d.width);
    for (const x of [0, d.width]) for (const z of [0, d.length]) along('y', { x, z }, d.height);
    for (const x of [0, d.width]) for (const y of [0, d.height]) along('z', { x, y }, d.length);
    return points;
  };
  // Ghost preview entity, one per player, pinned at the turned, sized footprint
  // centre with yaw = the wand rotation and the size group applied (see
  // bedrock-preview-entity.ts).
  const ghosts = new Map<string, { id: string; size: number }>();
  const removeGhost = (playerId: string) => {
    const g = ghosts.get(playerId); ghosts.delete(playerId);
    if (!g) return;
    try { world.getEntity(g.id)?.remove(); } catch {}
  };
  const syncGhost = (p: any, st: any, visible: boolean) => {
    if (!config.preview) return;
    if (!visible) { removeGhost(p.id); return; }
    const c = centreOffset(st);
    const at = { x: st.anchor.x + c.x, y: st.anchor.y, z: st.anchor.z + c.z };
    let ghost: any, entry = ghosts.get(p.id);
    if (entry) { try { ghost = world.getEntity(entry.id); } catch {} }
    if (ghost && ghost.dimension?.id !== p.dimension.id) { removeGhost(p.id); ghost = undefined; entry = undefined; }
    if (!ghost) {
      try { ghost = p.dimension.spawnEntity(config.preview.typeId, at); entry = { id: ghost.id, size: 100 }; ghosts.set(p.id, entry); } catch { return; }
    }
    if (entry && entry.size !== st.size) {
      entry.size = st.size;
      try { ghost.triggerEvent(sizeEvent(st.size)); } catch {}
    }
    try { ghost.teleport(at, { rotation: { x: 0, y: st.rotation } }); }
    catch { try { ghost.setRotation({ x: 0, y: st.rotation }); } catch {} }
  };
  // A ghost outliving its script (crash, reload) is swept when the pack starts.
  if (config.preview) system.run(() => {
    for (const id of ['overworld', 'nether', 'the_end']) {
      let d: any; try { d = world.getDimension(id); } catch { continue; }
      try { for (const e of d.getEntities({ type: config.preview.typeId })) e.remove(); } catch {}
    }
  });
  try { world.afterEvents.playerLeave.subscribe((ev: any) => { removeGhost(ev.playerId); states.delete(ev.playerId); previews.delete(ev.playerId); }); } catch {}
  const draw = (p: any) => {
    const st = state(p);
    syncGhost(p, st, previews.has(p.id) && !!st.anchor && !active && st.dimension === p.dimension.id);
    if (!previews.has(p.id) || !st.anchor || active) return;
    if (st.dimension !== p.dimension.id) { p.onScreenDisplay.setActionBar(`PREVIEW PAUSED · origin is in ${st.dimension} · re-pin here`); return; }
    const d = dims(st), particles: any[] = [];
    const worldCorner = (q: any) => ({ x: st.anchor.x + q.x, y: st.anchor.y + q.y, z: st.anchor.z + q.z });
    const mark = (effect: string, q: any) => particles.push({ effect, point: worldCorner(q) });
    const mode = st.aim ? 'AIMING' : 'PINNED PREVIEW';
    p.onScreenDisplay.setActionBar(`${mode} · ${config.label} · ${d.width}×${d.height}×${d.length} · ${st.rotation}°${st.size !== 100 ? ` · ${st.size}%` : ''} · §cX §aY §9Z §6MODEL -Z${st.aim ? ' · open the wand to pin' : ''}`);
    for (const q of outline(d)) mark('minecraft:endrod', q);
    const axisLength = 6;
    for (let i = 0; i <= axisLength; i++) {
      mark('minecraft:redstone_ore_dust_particle', { x: i, y: 0, z: 0 });
      mark('minecraft:villager_happy', { x: 0, y: i, z: 0 });
      mark('minecraft:water_splash_particle_manual', { x: 0, y: 0, z: i });
    }
    const front = [
      { x: config.width / 2, y: 1, z: 0 },
      { x: config.width / 2, y: 1, z: -1 },
      { x: config.width / 2, y: 1, z: -2 },
      { x: config.width / 2 - 1, y: 1, z: -1 },
      { x: config.width / 2 + 1, y: 1, z: -1 },
    ];
    const f = factor(st);
    for (const q of front) { const r = pointAt(q, st.rotation); mark('minecraft:totem_particle', { x: r.x * f, y: r.y * f, z: r.z * f }); }
    if (!config.preview) for (const sample of config.previewPoints) { const r = pointAt(sample, st.rotation); mark('minecraft:villager_happy', { x: r.x * f, y: r.y * f, z: r.z * f }); }
    for (const marker of particles.slice(0, 320)) try { p.dimension.spawnParticle(marker.effect, marker.point); } catch {}
  };
  // Aim mode: the preview follows the block the player looks at (its centre
  // lands on the face they hit), until they pin it or turn aim off.
  const aimTarget = (p: any) => {
    let hit: any;
    try { hit = p.getBlockFromViewDirection?.({ maxDistance: 96, includeLiquidBlocks: false, includePassableBlocks: false }); } catch { return undefined; }
    const b = hit?.block?.location;
    if (!b) return undefined;
    const face = String(hit.face || 'Up');
    const dx = face === 'East' ? 1 : face === 'West' ? -1 : 0, dy = face === 'Up' ? 1 : face === 'Down' ? -1 : 0, dz = face === 'South' ? 1 : face === 'North' ? -1 : 0;
    return { x: b.x + dx + 0.5, y: b.y + dy, z: b.z + dz + 0.5 };
  };
  const aimTick = () => {
    if (active) return;
    for (const p of world.getAllPlayers()) {
      const st = states.get(p.id);
      if (!st || !st.aim) continue;
      const target = aimTarget(p);
      if (!target) { try { p.onScreenDisplay.setActionBar(`AIMING · ${config.label} · look at a block within 96 blocks (not the sky)`); } catch {} continue; }
      pinCentredAt(p, st, target);
      draw(p);
    }
  };
  system.runInterval(() => { for (const p of world.getAllPlayers()) draw(p); }, 12);
  system.runInterval(aimTick, 4);
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
    const st = state(p), a = st.anchor || { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) };
    const r = await show(p, new ModalFormData().title(`${config.label} · Coordinates`).textField('X', '0', { defaultValue: String(a.x) }).textField('Y', '64', { defaultValue: String(a.y) }).textField('Z', '0', { defaultValue: String(a.z) }));
    if (r.canceled) return menu(p);
    const values = r.formValues.map((v: any) => Number(v));
    if (!values.every((v: number) => Number.isSafeInteger(v) && Math.abs(v) < 30000000)) { tell(p, 'Use whole-number world coordinates.'); return edit(p); }
    st.anchor = { x: values[0], y: values[1], z: values[2] }; st.dimension = p.dimension.id; st.aim = false; previews.add(p.id); return menu(p);
  }
  async function confirmPlace(p: any): Promise<any> {
    const st = state(p); try { validate(p, st); } catch (e: any) { tell(p, e.message); return menu(p); }
    const scripted = st.size !== 100 && config.tiles.length && config.colliders;
    const r = await show(p, new ActionFormData().title(`Place ${config.label}?`).body(`${summary(st)}\n\nBlocks in this area will be replaced.${scripted ? `\nAt ${st.size}% the invisible walkable blocks are re-laid to size; the ${config.colliders.keptCells} visible block${config.colliders.keptCells === 1 ? '' : 's'} (doors, lights) of the 100% export are left out.` : ''}`).button('Place now').button('Back'));
    if (!r.canceled && r.selection === 0) return place(p);
    return menu(p);
  }
  async function lighting(p: any): Promise<any> {
    const r = await show(p, new ActionFormData().title(`${config.label} · Lighting`).body('Night vision changes only your view. It does not place lights or change the build.').button('Enable night vision · 10 min').button('Disable night vision').button('Back'));
    if (r.canceled || r.selection === 2) return menu(p);
    try {
      if (r.selection === 0) { p.addEffect('minecraft:night_vision', 12000, { showParticles: false }); return tell(p, 'Night vision enabled for 10 minutes.'); }
      if (r.selection === 1) { p.removeEffect('minecraft:night_vision'); return tell(p, 'Night vision disabled.'); }
    } catch (e: any) { return tell(p, `Could not change night vision: ${e.message || e}`); }
  }
  // Colliders re-laid at another size: each exported cell covers a `factor`-wide
  // block range; its sixteenth heights are re-cut per world block row, and a
  // block two cells share (size < 100 %) keeps the lowest lo and highest hi.
  const pairOf = (index: number) => {
    let n = 1;
    for (let l = 0; l < 16; l++) { const span = 16 - l; if (index < n + span) return [l, l + 1 + (index - n)]; n += span; }
    return [0, 16];
  };
  async function placeColliders(st: any, dim: any, backups: any[], progress: (what: string) => void, key: string) {
    const c = config.colliders, f = factor(st), r = st.rotation, d = dims(st);
    const cellAt = (x: number, z: number) => r === 90 ? { x: c.length - 1 - z, z: x } : r === 180 ? { x: c.width - 1 - x, z: c.length - 1 - z } : r === 270 ? { x: z, z: c.width - 1 - x } : { x, z };
    const box = 48;
    const boxes: any[] = [];
    for (let bx = 0; bx < d.width; bx += box) for (let by = 0; by < d.height; by += 320) for (let bz = 0; bz < d.length; bz += box) {
      boxes.push({ x0: bx, y0: by, z0: bz, x1: Math.min(d.width, bx + box) - 1, y1: Math.min(d.height, by + 320) - 1, z1: Math.min(d.length, bz + box) - 1 });
    }
    const runs: string = c.runs;
    let placed = 0;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
      progress(`re-laying walkable blocks ${bi + 1}/${boxes.length}`);
      const from = { x: st.anchor.x + b.x0, y: st.anchor.y + b.y0, z: st.anchor.z + b.z0 }, to = { x: st.anchor.x + b.x1, y: st.anchor.y + b.y1, z: st.anchor.z + b.z1 };
      await load(dim, from, to);
      const name = `craftmatic:${key}_c${bi}`;
      world.structureManager.createFromWorld(name, dim, from, to, { includeEntities: false, saveMode: StructureSaveMode.Memory });
      backups.push({ name, from });
      // Clear the box first: a smaller re-lay must not leave the old size behind.
      try { dim.fillBlocks?.({ from, to }, 'minecraft:air'); } catch {}
      let cell = 0, budget = 0;
      for (let k = 0; k + 1 < runs.length; k += 2) {
        const v = runs.charCodeAt(k) - 40, n = runs.charCodeAt(k + 1) - 40 + 1;
        if (v === 0) { cell += n; continue; }
        const [lo, hi] = pairOf(v);
        for (let j = 0; j < n; j++, cell++) {
          const z = cell % c.length, y = Math.floor(cell / c.length) % c.height, x = Math.floor(cell / (c.length * c.height));
          const rc = cellAt(x, z);
          const x0 = Math.floor(rc.x * f), x1 = Math.max(x0, Math.ceil((rc.x + 1) * f) - 1);
          const z0 = Math.floor(rc.z * f), z1 = Math.max(z0, Math.ceil((rc.z + 1) * f) - 1);
          if (x1 < b.x0 || x0 > b.x1 || z1 < b.z0 || z0 > b.z1) continue;
          const wy0 = (y + lo / 16) * f, wy1 = (y + hi / 16) * f;
          for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
            if (wy < b.y0 || wy > b.y1) continue;
            let l = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16)));
            let h = Math.max(l + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
            for (let wx = Math.max(x0, b.x0); wx <= Math.min(x1, b.x1); wx++) for (let wz = Math.max(z0, b.z0); wz <= Math.min(z1, b.z1); wz++) {
              const pos = { x: st.anchor.x + wx, y: st.anchor.y + wy, z: st.anchor.z + wz };
              let block: any;
              try { block = dim.getBlock(pos); } catch {}
              if (!block) continue;
              let bl = l, bh = h;
              try {
                if (block.typeId === c.block) {
                  const pl = Number(block.permutation.getState(c.loState)), ph = Number(block.permutation.getState(c.hiState));
                  if (Number.isFinite(pl) && Number.isFinite(ph)) { bl = Math.min(bl, pl); bh = Math.max(bh, ph); }
                }
              } catch {}
              try { block.setPermutation(BlockPermutation.resolve(c.block, { [c.loState]: bl, [c.hiState]: bh })); placed++; } catch {}
              if (++budget % 400 === 0) {
                if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
                await wait(1);
              }
            }
          }
        }
      }
      await wait(config.settleTicks);
    }
    return placed;
  }
  async function place(p: any) {
    if (active) return tell(p, 'Another placement is running.');
    const st = { ...state(p), anchor: { ...state(p).anchor } }, dim = p.dimension;
    validate(p, st); active = { player: p.id, cancelled: false }; previews.delete(p.id); state(p).aim = false;
    const key = `${config.id}_${p.id.replaceAll('-', '').slice(0, 8)}_${Date.now().toString(36)}`, backups: any[] = [], entities: string[] = [], failedActors: string[] = [], spawned: any[] = [];
    const previous = histories.get(p.id);
    removeGhost(p.id);
    const scripted = st.size !== 100 && config.tiles.length > 0;
    // Live progress on the action bar (the chat log scrolls away); one chat
    // line at the start and one at the end.
    const total = (scripted ? 1 : config.tiles.length) + config.actors.length, settle = config.settleTicks, hold = config.finalHoldTicks;
    const progress = (done: number, what: string) => {
      const n = 12, k = Math.max(0, Math.min(n, Math.round(done / Math.max(1, total) * n)));
      try { p.onScreenDisplay.setActionBar(`§b[Brick Wand]§r ${'▰'.repeat(k)}§8${'▱'.repeat(n - k)}§r ${Math.round(done / Math.max(1, total) * 100)}% · ${what}`); } catch {}
    };
    const pieces = `${scripted ? 'the walkable blocks' : `${config.tiles.length} structure piece${config.tiles.length === 1 ? '' : 's'}`}${config.actors.length ? ` and ${config.actors.length} entit${config.actors.length === 1 ? 'y' : 'ies'}` : ''}${st.size !== 100 ? ` at ${st.size}%` : ''}`;
    tell(p, `Placing ${config.label}: ${pieces}. Watch the bar above the hotbar.`);
    try {
      if (scripted) {
        const placed = await placeColliders(st, dim, backups, what => progress(0, what), key);
        progress(1, `${placed} walkable blocks laid`);
      } else for (let i = 0; i < config.tiles.length; i++) {
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        const t = tileAt(config.tiles[i], st.rotation), from = { x: st.anchor.x + t.dx, y: st.anchor.y + t.dy, z: st.anchor.z + t.dz }, to = { x: from.x + t.width - 1, y: from.y + t.height - 1, z: from.z + t.length - 1 }, name = `craftmatic:${key}_${i}`;
        progress(i, `loading area for piece ${i + 1}/${config.tiles.length}`);
        await load(dim, from, to);
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        world.structureManager.createFromWorld(name, dim, from, to, { includeEntities: false, saveMode: StructureSaveMode.Memory });
        backups.push({ name, from });
        // A failed `structure load` (unknown structure, bad rotation) reports
        // successCount 0 without throwing; treated as success it placed nothing
        // and reported 100 %.
        const loadResult = await dim.runCommand(`structure load ${t.identifier} ${from.x} ${from.y} ${from.z} ${st.rotation}_degrees none`);
        if (loadResult && loadResult.successCount === 0) throw new Error(`structure ${t.identifier} could not be loaded (piece ${i + 1}/${config.tiles.length}). Is the behavior pack's structures folder intact?`);
        progress(i + 1, `piece ${i + 1}/${config.tiles.length} placed`);
        // Let the chunks tick with the area still alive so the block updates
        // reach every client before the area (and maybe the chunk) goes away.
        await wait(settle);
      }
      const done0 = scripted ? 1 : config.tiles.length;
      for (let j = 0; j < config.actors.length; j++) {
        const actor = config.actors[j];
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        const q = worldPoint(st, actor);
        progress(done0 + j, `spawning ${actor.label}`);
        await load(dim, { x: q.x - 1, z: q.z - 1 }, { x: q.x + 1, z: q.z + 1 });
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        // One entity that fails to spawn (a type the content log rejected)
        // must not stop the rest: the Pixel round of 2026-09-16 lost every
        // vehicle placement to its first figure NPC.
        try {
          // A figure dropped into a WALL cell can never path out: lift it to the first
          // cell whose feet and head cells are not walls. A part-height collider (a
          // floor plate 0..3/16, a ceiling slab) is not a wall - the game stands the
          // figure on it - so only a collider spanning 12+ sixteenths counts. If no
          // clear cell is found within three blocks the figure stays where the source
          // put it (round b lifted one onto the roof by testing "any collider").
          let spawnY = q.y;
          if (config.colliders && /_fig[0-9]+$/.test(actor.typeId)) {
            const bx = Math.floor(q.x), bz = Math.floor(q.z);
            const wall = (y: number) => {
              try {
                const b = dim.getBlock({ x: bx, y, z: bz });
                if (!b || b.typeId !== config.colliders.block) return false;
                const lo = Number(b.permutation.getState(config.colliders.loState)), hi = Number(b.permutation.getState(config.colliders.hiState));
                return !(Number.isFinite(lo) && Number.isFinite(hi)) || hi - lo >= 12;
              } catch { return false; }
            };
            const y0 = Math.floor(q.y);
            for (let up = 0; up <= 3; up++) {
              if (!wall(y0 + up) && !wall(y0 + up + 1)) { spawnY = up ? y0 + up : q.y; break; }
            }
          }
          const entity = dim.spawnEntity(actor.typeId, { x: q.x, y: spawnY, z: q.z });
          entity.nameTag = actor.label; entity.setRotation({ x: 0, y: (actor.yaw || 0) + st.rotation }); entities.push(entity.id); spawned[j] = entity;
          if (st.size !== 100) { try { entity.triggerEvent(sizeEvent(st.size)); } catch (e: any) { tell(p, `§e${actor.label} could not take size ${st.size}% (${e && e.message ? e.message : e}); it stands at 100%.`); } }
          progress(done0 + j + 1, `${actor.label} placed`);
        } catch (e: any) {
          failedActors.push(actor.label);
          tell(p, `§e${actor.label} could not be spawned (${e && e.message ? e.message : e}); continuing.`);
          progress(done0 + j + 1, `${actor.label} skipped`);
        }
        await wait(settle);
      }
      // A figure the source seated on a chair rides that chair's seat entity (its sit pose plays while riding).
      for (let j = 0; j < config.actors.length; j++) {
        const actor = config.actors[j];
        if (actor.rideOf === undefined || !spawned[j] || !spawned[actor.rideOf]) continue;
        try {
          const seat = spawned[actor.rideOf].getComponent('minecraft:rideable');
          if (!seat || !seat.addRider(spawned[j])) tell(p, `§e${actor.label} could not take its seat; it stands instead.`);
        } catch (e: any) { tell(p, `§e${actor.label} could not take its seat (${e && e.message ? e.message : e}).`); }
      }
      if (previous) for (const b of previous.backups) try { world.structureManager.delete(b.name); } catch {}
      histories.set(p.id, { dimension: dim.id, backups, entities });
      progress(total, 'done');
      await wait(hold);
      tell(p, failedActors.length ? `§aPlaced ${config.label} (${failedActors.length} entit${failedActors.length === 1 ? 'y' : 'ies'} could not be spawned). Use the Brick Wand to undo.` : `§aPlaced ${config.label}. Use the Brick Wand to undo.`);
    } catch (e: any) {
      if (backups.length || entities.length) {
        if (previous) for (const b of previous.backups) try { world.structureManager.delete(b.name); } catch {}
        histories.set(p.id, { dimension: dim.id, backups, entities });
      }
      tell(p, `§cPlacement stopped: ${e.message || e}`);
    }
    finally { await unload(); active = undefined; }
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
    finally { await unload(); active = undefined; }
  }
  async function menu(p: any): Promise<any> {
    const st = state(p), running = active?.player === p.id;
    const nextSize = sizes[(sizes.indexOf(st.size) + 1) % sizes.length];
    const f = new ActionFormData().title(`${config.label} · Brick Wand`).body(`${summary(st)}\n\nPreview first: ${config.preview ? 'a translucent ghost of the whole build stands at the pin, turned to the chosen rotation and size, with' : 'a full-size outline and model markers stay fixed at the pinned placement;'} red/green/blue marking +X/+Y/+Z and gold the model's -Z side. "Follow my aim" moves it to wherever you look until you pin. Place is always a separate confirmation.`);
    if (running) f.button('Cancel placement');
    else {
      f.button('Pin centred on me').button('Pin corner at my feet').button('Edit coordinates').button(`Rotate → ${(st.rotation + turnStep) % 360}°`).button('View preview in world').button('Place…').button('Undo last placement').button('Hide preview').button('Lighting / night vision');
      f.button(st.aim ? 'Stop following my aim' : 'Follow my aim').button(`Size ${st.size}% → ${nextSize}%${!blocksResizable && nextSize !== 100 ? ' (entities only)' : ''}`);
      if (fineTurn) f.button(`Turn back ← ${((st.rotation - turnStep) % 360 + 360) % 360}°`);
    }
    if (!running && config.vehicleControls) f.button('DeLorean controls');
    const r = await show(p, f); if (r.canceled) return;
    if (running) { if (active?.player === p.id) active.cancelled = true; return tell(p, 'Cancel requested.'); }
    if (r.selection === 0) {
      // The origin is the model's corner; put the ROTATED, SIZED footprint centre on the player so a
      // vehicle-only pack lands where they stand instead of half a model away.
      st.aim = false;
      pinCentredAt(p, st, p.location);
      return menu(p);
    }
    if (r.selection === 1) { st.aim = false; st.anchor = { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) }; st.dimension = p.dimension.id; previews.add(p.id); return menu(p); }
    if (r.selection === 2) return edit(p);
    if (r.selection === 3) {
      st.rotation = fineTurn ? (st.rotation + turnStep) % 360 : rotations[(rotations.indexOf(st.rotation) + 1) % 4];
      if (st.anchor) previews.add(p.id); return menu(p);
    }
    if (r.selection === 4) { try { validate(p, st); } catch (e: any) { tell(p, e.message); return menu(p); } previews.add(p.id); return tell(p, config.preview ? "The ghost stands at the pin, turned to the chosen rotation and size. Switch away from the wand and back to rotate, resize or place." : "Full-size preview fixed at the pin. Red/green/blue mark +X/+Y/+Z; gold marks the model's -Z side. Switch away from the wand and back to rotate or place."); }
    if (r.selection === 5) return confirmPlace(p);
    if (r.selection === 6) return undo(p);
    if (r.selection === 7) { previews.delete(p.id); st.aim = false; removeGhost(p.id); return tell(p, 'Preview hidden.'); }
    if (r.selection === 8) return lighting(p);
    if (r.selection === 9) {
      st.aim = !st.aim;
      if (st.aim) { previews.add(p.id); const target = aimTarget(p); if (target) pinCentredAt(p, st, target); return tell(p, 'The preview now follows the block you look at. Open the wand and pin (or place) when it is where you want it.'); }
      return tell(p, st.anchor ? 'The preview stays where it is.' : 'Aim stopped.');
    }
    if (r.selection === 10) {
      st.size = nextSize;
      if (st.anchor) previews.add(p.id);
      if (!blocksResizable && nextSize !== 100) tell(p, 'This pack\'s blocks were exported as coloured blocks: only the entities take the new size. Export again with brick-accurate buildings or at another model scale for the blocks to follow.');
      return menu(p);
    }
    if (fineTurn && r.selection === 11) { st.rotation = ((st.rotation - turnStep) % 360 + 360) % 360; if (st.anchor) previews.add(p.id); return menu(p); }
    if (r.selection === (fineTurn ? 12 : 11) && config.vehicleControls && openVehicleControls) return openVehicleControls(p);
  }
  world.afterEvents.itemUse.subscribe((ev: any) => { if (ev.itemStack.typeId === config.itemId) system.run(() => menu(ev.source).catch((e: any) => tell(ev.source, e.message || String(e)))); });
  console.warn(`BRICK_WAND_READY ${config.id}`);
}

export function buildPlacementPackAssets(spec: PlacementPackSpec): PlacementPackAssets {
  const id = spec.stem.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
  const itemId = `craftmatic:${id}_brick_wand`;
  const shortAlias = placementAlias(spec.stem);
  const config = { id, shortAlias, vehicleControls: spec.vehicleControls === true, label: spec.label, itemId, width: spec.width, height: spec.height, length: spec.length, tiles: spec.tiles, actors: spec.actors ?? [], previewPoints: (spec.previewPoints ?? []).slice(0, 120),
    preview: spec.preview ?? null, colliders: spec.colliders ?? null, sizes: [...SIZE_STEPS], sizeEventPrefix: SIZE_EVENT_PREFIX, settleTicks: spec.settleTicks ?? 8, finalHoldTicks: spec.finalHoldTicks ?? 40 };
  const controlsImport = spec.vehicleControls ? 'import { showTimeMachineControls } from "./time-machine.js";\n' : '';
  const script = `${controlsImport}import { world, system, StructureSaveMode, BlockPermutation } from "@minecraft/server";\nimport { ActionFormData, ModalFormData } from "@minecraft/server-ui";\nconst CONFIG = ${JSON.stringify(config)};\n(${placementRuntime.toString()})(CONFIG${spec.vehicleControls ? ", showTimeMachineControls" : ""});\n`;
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
  const grant = `give @s ${itemId} 1\ntellraw @s ${JSON.stringify({ rawtext: [{ text: `§b[BrickWand]§r Select ${spec.label} BrickWand in your hotbar to open it. Switch away and back to reopen. "Follow my aim" moves the ghost preview to wherever you look; pin, rotate and size it, then place.` }] })}\n`;
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
