/**
 * Offline census of a pack's minifig NPCs under scripts/figures.js
 * (web/src/engine/bedrock-figure-life.ts): for every figure, where the
 * placement lifts it at spawn, how much floor it can reach under the planner,
 * and what the shipped runtime does with it over a simulated watch in the host
 * world of figure-life-sim.ts (the pack's own collider grid, a flat ground at
 * the pin plane, its seats and door leaves). The device GameTest
 * (`figures_<id>`, gametest-pack.ts) is the ground truth; this answers the
 * same questions in seconds, for every favourite.
 *
 * Usage: bun scripts/_figure_roam_census.ts <pack.mcaddon>... [--ticks=1200] [--json=out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadAddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';
import { exploreWalkable, FIGURE_TUNING, spawnLift, standFeetAt, startCell, type SpanLookup } from '../web/src/engine/bedrock-figure-life.ts';
import { simulateFigureLife, type SimWorld } from '../web/src/engine/figure-life-sim.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const ticks = Number(flag('ticks') ?? 1200);
if (!files.length) { console.error('usage: bun scripts/_figure_roam_census.ts <pack.mcaddon>... [--ticks=1200] [--json=out.json]'); process.exit(2); }

const out: unknown[] = [];
for (const file of files) {
  const bytes = readFileSync(file);
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const grid = new Map(model.cells.map(c => [`${c.x},${c.y},${c.z}`, c]));
  const span: SpanLookup = (x, y, z) => {
    const c = grid.get(`${x},${y},${z}`);
    if (c) return c.hi > c.lo ? [y + c.lo / 16, y + c.hi / 16] : null;
    return y < 0 ? [y, y + 1] : null;
  };
  const figures = model.entities.filter(e => e.kind === 'figure');
  const seats = model.entities.filter(e => e.kind === 'seat');
  const leaves = model.entities.filter(e => e.interactive !== undefined);
  const bodyHeights: Record<string, number> = {};
  for (const f of figures) bodyHeights[f.typeId] = model.entityCollision.get(f.typeId)?.height ?? 1.8;
  // The placement's spawn lift (bedrock-placement-pack.ts), at 100 %: raise the
  // 1.8-block body past any span it overlaps, within a 3-block budget.
  const lift = (x: number, y: number, z: number): number => (model.cells.length ? spawnLift(span, x, z, y, 1.8, 3) : y);
  const area: [number, number, number, number] = [0, 0, model.dims.width, model.dims.length];
  const world: SimWorld = {
    cells: model.cells, area, ground: 0,
    figures: figures.map(f => ({ typeId: f.typeId, at: { x: f.x, y: lift(f.x, f.y, f.z), z: f.z }, mode: f.rideOf !== undefined ? 'seated' as const : 'roam' as const })),
    seats: seats.map(s => ({ typeId: s.typeId, at: { x: s.x, y: s.y, z: s.z } })),
    leaves: leaves.map(l => ({ x: l.x, y: l.y, z: l.z })),
  };
  const tracks = simulateFigureLife(world, { figureTypes: figures.map(f => f.typeId), seatTypes: [...new Set(seats.map(s => s.typeId))], bodyHeights, bodyHeight: 1.8, tuning: FIGURE_TUNING }, ticks, 17);
  const rows = figures.map((f, k) => {
    const at = world.figures[k]!.at, t = tracks[k]!;
    const body = bodyHeights[f.typeId]!;
    const inArea = (x: number, z: number): boolean => x + 0.5 >= area[0] && x + 0.5 <= area[2] && z + 0.5 >= area[1] && z + 0.5 <= area[3];
    const start = startCell(span, at.x, at.z, at.y, body, FIGURE_TUNING.maxUp, FIGURE_TUNING.maxDown, standFeetAt, (x, z) => inArea(x, z), 1);
    const ownColumn = standFeetAt(span, Math.floor(at.x), Math.floor(at.z), at.y, body, 0.3, FIGURE_TUNING.maxDown) !== null;
    const feet = start ? start.feet : 0;
    const reach = !start ? 0 : exploreWalkable(span, start, body, FIGURE_TUNING.maxUp, FIGURE_TUNING.maxDown,
      (x, z, ff) => x + 0.5 >= area[0] && x + 0.5 <= area[2] && z + 0.5 >= area[1] && z + 0.5 <= area[3] && Math.abs(ff - feet) <= FIGURE_TUNING.band
        && (x + 0.5 - at.x) ** 2 + (z + 0.5 - at.z) ** 2 <= FIGURE_TUNING.radius ** 2, FIGURE_TUNING.maxNodes, standFeetAt).length;
    // Headroom over the spawn column: the lowest span bottom above the feet.
    let headroom = Infinity;
    for (let y = Math.floor(at.y); y < Math.floor(at.y) + 6; y++) { const s = span(Math.floor(at.x), y, Math.floor(at.z)); if (s && s[0]! > at.y + 1e-6) { headroom = Math.min(headroom, s[0]! - at.y); } }
    let path = 0;
    for (let i = 1; i < t.length; i++) path += Math.hypot(t[i]!.x - t[i - 1]!.x, t[i]!.z - t[i - 1]!.z);
    const outside = t.filter(p => p.x < area[0] - 1 || p.x > area[2] + 1 || p.z < area[1] - 1 || p.z > area[3] + 1).length;
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    return {
      label: f.label, seated: f.rideOf !== undefined, spawn: [r2(at.x), r2(at.y), r2(at.z)], lifted: r2(at.y - f.y), headroom: Number.isFinite(headroom) ? r2(headroom) : null,
      standable: ownColumn, startsBeside: !!start && !ownColumn, reachCells: reach, path: r2(path), moved: path >= 2, outside, minY: r2(Math.min(...t.map(p => p.y))), // A rider sits at its seat's height, not where the census lifted it: not a fall.
      dropped: f.rideOf === undefined && t[t.length - 1]!.y < at.y - 1.5 && !t[t.length - 1]!.riding,
      ridingTicks: t.filter(p => p.riding).length,
    };
  });
  const roamers = rows.filter(r => !r.seated);
  const summary = {
    pack: basename(file), figures: rows.length, seated: rows.length - roamers.length, roamers: roamers.length,
    moved: roamers.filter(r => r.moved).length, stay: roamers.filter(r => r.reachCells < FIGURE_TUNING.minRoamCells).map(r => r.label),
    leftArea: rows.filter(r => r.outside).map(r => r.label), dropped: rows.filter(r => r.dropped).map(r => r.label),
    sat: roamers.filter(r => r.ridingTicks > 0).map(r => r.label), ticks,
  };
  console.log(`\n${model.label} (${basename(file)}): ${summary.moved}/${summary.roamers} roamers moved, ${summary.seated} seated, stay ${summary.stay.length}, left ${summary.leftArea.length}, dropped ${summary.dropped.length}`);
  for (const r of rows) console.log(`  ${r.label.padEnd(28)} ${r.seated ? 'seated' : 'roam  '} spawn ${JSON.stringify(r.spawn)} lift ${r.lifted} head ${r.headroom}${r.startsBeside ? ' (starts beside)' : ''} reach ${String(r.reachCells).padStart(3)} path ${String(r.path).padStart(6)} out ${r.outside} minY ${r.minY}${r.ridingTicks ? ` sat ${r.ridingTicks}t` : ''}`);
  out.push({ summary, rows });
}
const json = flag('json');
if (json) writeFileSync(json, JSON.stringify(out, null, 1) + '\n');
