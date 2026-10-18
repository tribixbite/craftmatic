/**
 * Invisible-step (tread) measurement on a real pack or source
 * (engine/bedrock-collider-scale.ts, `planColliderTreads`): at every wand size
 * step, the highest surface a player reaches on foot from outside the model
 * WITHOUT treads and WITH them, the tread counts, what could not be restored
 * and why, and whether named model points (a coaster's boarding platform) are
 * reachable.
 *
 * Usage: bun scripts/_collider_treads.ts <pack.mcaddon | model.io|.mpd|.ldr> [--turns] [--sizes=100,150,200,300,400]
 *        [--target=x,y,z[:label]]... [--json]
 *   A `.mcaddon` is read as shipped (its CONFIG colliders); a source is built
 *   through the pipeline the way the LEGO tab exports it (auto scale). When the
 *   pack's diagnostics carry a coaster station, it becomes a target automatically.
 *   --turns   plan every quarter turn (default: 0° only; the pack itself ships all four).
 *   --route   for each target reached, print the walk's route from the ring to it (model blocks at 100 %),
 *             so it can be checked on foot in the game; for a target not reached, the nearest reached surface.
 *   --refused print the refused edges (model blocks at 100 %) and the surfaces they wanted.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import { colliderSourceCells, type PlacementColliders } from '../web/src/engine/bedrock-placement-pack.ts';
import { QUARTER_TURNS, ScaledColliderGrid, blocksAt100, planColliderTreads, type QuarterTurn, type ReachTarget, type Surface, type TreadPlan } from '../web/src/engine/bedrock-collider-scale.ts';

/**
 * The walk with parents, over the grid as the runtime leaves it (lay + plan):
 * the route from the ring to a target's nearest reached surface, or the
 * reached surface nearest the target when none is within reach of it.
 */
function routeTo(grid: ScaledColliderGrid, target: { x: number; z: number; y16: number; radius: number }, f: number): { route: Surface[]; reached: boolean; nearest: Surface | null } {
  const parent = new Map<number, number>();
  const queue: Surface[] = [];
  const push = (s: Surface, from: number): void => { const k = grid.key(s.x, s.z, s.t); if (parent.has(k)) return; parent.set(k, from); queue.push(s); };
  for (let x = -1; x <= grid.width; x++) for (let z = -1; z <= grid.length; z++) {
    if (x !== -1 && z !== -1 && x !== grid.width && z !== grid.length) continue;
    for (const t of grid.surfaces(x, z)) push({ x, z, t }, -1);
  }
  let goal: Surface | null = null, nearest: Surface | null = null, nearestD = Infinity;
  for (let h = 0; h < queue.length && !goal; h++) {
    const s = queue[h]!;
    if (grid.inside(s.x, s.z)) {
      const d = Math.hypot(s.x - target.x, s.z - target.z) + Math.abs(s.t - target.y16) / 16;
      if (d < nearestD) { nearestD = d; nearest = s; }
      if (Math.abs(s.x - target.x) <= target.radius && Math.abs(s.z - target.z) <= target.radius && Math.abs(s.t - target.y16) <= 16 * f) { goal = s; break; }
    }
    for (const [nx, nz] of [[s.x + 1, s.z], [s.x - 1, s.z], [s.x, s.z + 1], [s.x, s.z - 1]] as const) {
      if (!grid.inRing(nx, nz)) continue;
      for (const t of grid.surfaces(nx, nz)) if (grid.canRise(s.x, s.z, s.t, t)) push({ x: nx, z: nz, t }, grid.key(s.x, s.z, s.t));
    }
  }
  const route: Surface[] = [];
  for (let k = goal ? grid.key(goal.x, goal.z, goal.t) : -1; k !== -1; k = parent.get(k)!) route.unshift(grid.unkey(k));
  return { route, reached: goal !== null, nearest };
}

/** A surface as model blocks at 100 % from the model's corner (x, z centre of the column; y its top). */
const at100 = (s: Surface, f: number): string => `(${((s.x + 0.5) / f).toFixed(2)}, ${blocksAt100(s.t, f)}, ${((s.z + 0.5) / f).toFixed(2)})`;

/** The route compressed to its rises and drops: consecutive flat moves are one segment. */
function describeRoute(route: Surface[], f: number): string {
  const parts: string[] = [];
  let flat = 0;
  for (let i = 1; i < route.length; i++) {
    const d = route[i]!.t - route[i - 1]!.t;
    if (d === 0) { flat++; continue; }
    if (flat) { parts.push(`${flat} flat`); flat = 0; }
    parts.push(`${d > 0 ? 'UP' : 'down'} ${Math.abs(d / 16 / f).toFixed(2)} to ${at100(route[i]!, f)}`);
  }
  if (flat) parts.push(`${flat} flat`);
  return parts.join(' → ');
}

function planGrid(plan: TreadPlan, cells: ReturnType<typeof colliderSourceCells>, dims: { width: number; height: number; length: number }): ScaledColliderGrid {
  const grid = new ScaledColliderGrid(cells, dims, plan.sizePct / 100, plan.rotation);
  for (const b of plan.blocks) grid.write(b.x, b.z, { row: b.y, lo: b.lo, hi: b.hi, src16: 0 });
  return grid;
}

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = positional[0];
if (!file) { console.error('usage: bun scripts/_collider_treads.ts <pack.mcaddon | model> [--turns] [--sizes=...] [--target=x,y,z[:label]]... [--json]'); process.exit(2); }

const targets: ReachTarget[] = process.argv.filter(a => a.startsWith('--target=')).map((a, i) => {
  const [coords, label] = a.slice('--target='.length).split(':');
  const [x, y, z] = coords!.split(',').map(Number) as [number, number, number];
  return { label: label ?? `target ${i + 1}`, x, y, z };
});
const sizes = (flag('sizes') ?? '100,150,200,300,400').split(',').map(Number);
const turns: readonly QuarterTurn[] = process.argv.includes('--turns') ? QUARTER_TURNS : [0];

/** The shipped colliders of a pack's placement script, plus its diagnostics when present. */
async function fromPack(buffer: ArrayBuffer): Promise<{ colliders: PlacementColliders; diagnostics: any; label: string }> {
  const entries = listZipEntries(buffer);
  const scriptName = entries.find(e => e.endsWith('scripts/placement.js'));
  if (!scriptName) throw new Error('no scripts/placement.js in the pack');
  const script = new TextDecoder().decode(await extractFile(buffer, scriptName));
  const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(script)![1]!);
  if (!config.colliders) throw new Error('this pack has no collider grid (coloured-block export): nothing to re-lay or step');
  const diagName = entries.find(e => e.endsWith('craftmatic-diagnostics.json'));
  const diagnostics = diagName ? JSON.parse(new TextDecoder().decode(await extractFile(buffer, diagName))) : null;
  return { colliders: config.colliders, diagnostics, label: config.label };
}

/** Build the pack the LEGO tab would export for a source (auto scale), then read it as shipped. */
async function fromSource(path: string): Promise<{ colliders: PlacementColliders; diagnostics: any; label: string }> {
  const { extractIoModel } = await import('../web/src/engine/io-extractor.ts');
  const { embeddedPartTexts, parseLDrawDocument } = await import('../web/src/engine/ldraw-parser.ts');
  const { synthesizeLSynth } = await import('../web/src/engine/lsynth.ts');
  const { seedDatTexts, setLDrawRoot } = await import('../web/src/engine/ldraw-geometry.ts');
  const { runSchemPipeline } = await import('../web/src/engine/schem-pipeline.ts');
  const { planResolutionAtCell, spanOfBricks } = await import('../web/src/engine/schem-settings.ts');
  const { planAddonScale } = await import('../web/src/engine/addon-scale.ts');
  const { LDU_PER_BLOCK } = await import('../web/src/engine/lego-scale.ts');
  setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
  let text: string;
  let customParts = new Map<string, string>();
  if (/\.io$/i.test(path)) {
    const b = readFileSync(path);
    const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    text = io.text; customParts = io.customParts;
  } else text = readFileSync(path, 'utf8');
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  seedDatTexts([...embeddedPartTexts(doc), ...customParts]);
  const label = basename(path).replace(/\.[^.]+$/, '');
  const scalePlan = planAddonScale(doc.bricks, 'auto', label);
  const plan = planResolutionAtCell(spanOfBricks(doc.bricks), scalePlan.lduPerBlock);
  const modelScale = Math.round(LDU_PER_BLOCK / plan.cellLDU * 1000) / 1000;
  console.error(`  building ${label}: ${scalePlan.reason} (cell ${Math.round(plan.cellLDU * 100) / 100} LDU, ${modelScale}x)`);
  const t0 = Date.now();
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: plan.cellLDU, maxDim: 700 } },
    format: 'mcaddon', packStem: `Set${label}`, packLabel: label, profile: 'default', modelScale,
    lightFill: false, shapes: false, vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced',
  });
  console.error(`  built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const bytes = result.bytes!;
  return fromPack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

const source = /\.mcaddon$/i.test(file)
  ? await fromPack((() => { const b = readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; })())
  : await fromSource(file);
const station = source.diagnostics?.coaster?.routes?.[0]?.station?.point;
if (Array.isArray(station) && station.length === 3 && !targets.some(t => t.label === 'coaster station')) {
  targets.push({ label: 'coaster station', x: station[0], y: station[1], z: station[2] });
}
const dims = { width: source.colliders.width, height: source.colliders.height, length: source.colliders.length };
const cells = colliderSourceCells(source.colliders);
console.log(`${source.label}: ${dims.width}×${dims.height}×${dims.length} cells, ${cells.length} solid; targets: ${targets.map(t => `${t.label} [${t.x}, ${t.y}, ${t.z}]`).join('; ') || 'none'}`);
const rows: any[] = [];
for (const pct of sizes) for (const r of turns) {
  const t0 = Date.now();
  const plan = planColliderTreads(cells, dims, pct, r, targets);
  const ms = Date.now() - t0;
  const f = pct / 100;
  const row = {
    size: pct, turn: r,
    highestBefore: blocksAt100(plan.before.highest16, f), highestAfter: blocksAt100(plan.after.highest16, f),
    surfacesBefore: plan.before.surfaces, surfacesAfter: plan.after.surfaces,
    treadBlocks: plan.blocks.length, runs: plan.runs.length, unrestored: plan.unrestored, verified: plan.verified,
    hops: plan.runs.length ? `${Math.min(...plan.runs.map(x => x.hop16))}..${Math.max(...plan.runs.map(x => x.hop16))}/16` : '-',
    targets: (plan.targets ?? []).map(t => ({ label: t.label, before: t.reachedBefore, after: t.reachedAfter, nearestAfter: t.nearestAfter, column: t.column })),
    ms,
  };
  rows.push(row);
  const tgt = row.targets.map(t => `${t.label}: ${t.before ? 'reached' : 'NOT reached'} bare, ${t.after ? 'reached' : 'NOT reached'} with treads${t.nearestAfter !== null ? ` (surface at ${t.nearestAfter} blocks)` : ''}`).join('; ');
  console.log(`  ${String(pct).padStart(3)} % ${String(r).padStart(3)}°: highest ${row.highestBefore} -> ${row.highestAfter} blocks (at 100 %); surfaces ${row.surfacesBefore} -> ${row.surfacesAfter}; ${row.treadBlocks} tread blocks in ${row.runs} runs (hops ${row.hops}); unrestored ${JSON.stringify(row.unrestored)} of which ${plan.refusedUnreached} target surfaces stay unreachable; ${row.verified ? 'verified' : 'NOT VERIFIED'}; ${ms} ms${tgt ? `\n         ${tgt}` : ''}`);
  if (process.argv.includes('--route') && plan.targets) {
    const grid = planGrid(plan, cells, dims);
    for (const t of plan.targets) {
      const { route, reached, nearest } = routeTo(grid, { x: t.column.x, z: t.column.z, y16: Math.round(t.y * f * 16), radius: t.column.radius }, f);
      if (reached) console.log(`         route to ${t.label} (${route.length} surfaces, model blocks at 100 %): start ${at100(route[0]!, f)} → ${describeRoute(route, f)}`);
      else console.log(`         no route to ${t.label}; the nearest reached surface is ${nearest ? at100(nearest, f) : 'none'}`);
    }
  }
  if (process.argv.includes('--refused')) for (const e of plan.refused) console.log(`         refused ${e.reason}: from ${at100(e.from, f)} up ${((e.to.t - e.from.t) / 16 / f).toFixed(2)} (at 100 %) to ${at100(e.to, f)}`);
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ label: source.label, dims, cells: cells.length, targets, rows }, null, 1));
