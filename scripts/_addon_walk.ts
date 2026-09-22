/**
 * Walkable-preview measurement on a real pack (engine/addon-walk.ts): at every
 * wand size step, what a player standing in the shipped collider world can
 * reach on foot - the highest surface by the reach walk and by the continuous
 * player, whether named model points (a coaster's station) are reachable and
 * by which route, and where the two models disagree and why.
 *
 * Usage: bun scripts/_addon_walk.ts <pack.mcaddon> [--sizes=100,150,200,300,400] [--turns]
 *        [--target=x,y,z[:label]]... [--treads=shipped|planned|none] [--all] [--divergences=N] [--json]
 *   A `.mcaddon` is read as shipped (its CONFIG colliders and tread plans). When
 *   the pack's diagnostics carry a coaster station, it becomes a target.
 *   --turns        every quarter turn (default: 0° only).
 *   --treads       shipped (default; a pack without plans is walked bare), planned (plan afresh), none.
 *   --all          also try moves the reach walk refuses (rise within the jump): finds surfaces only the player reaches.
 *   --divergences  print up to N disagreeing surfaces per size with the attempts made (default 5).
 */
import { readFileSync } from 'node:fs';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import { colliderSourceCells, treadBlocksFor, type PlacementColliders } from '../web/src/engine/bedrock-placement-pack.ts';
import { QUARTER_TURNS, blocksAt100, type QuarterTurn, type ReachTarget } from '../web/src/engine/bedrock-collider-scale.ts';
import { buildWalkWorld, compareReach, reachPoint, routeAsModelPoints, type PointReach } from '../web/src/engine/addon-walk.ts';

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = positional[0];
if (!file) { console.error('usage: bun scripts/_addon_walk.ts <pack.mcaddon> [--sizes=...] [--turns] [--target=x,y,z[:label]]... [--treads=shipped|planned|none] [--all] [--json]'); process.exit(2); }

const targets: ReachTarget[] = process.argv.filter(a => a.startsWith('--target=')).map((a, i) => {
  const [coords, label] = a.slice('--target='.length).split(':');
  const [x, y, z] = coords!.split(',').map(Number) as [number, number, number];
  return { label: label ?? `target ${i + 1}`, x, y, z };
});
const sizes = (flag('sizes') ?? '100,150,200,300,400').split(',').map(Number);
const turns: readonly QuarterTurn[] = process.argv.includes('--turns') ? QUARTER_TURNS : [0];
const treads = (flag('treads') ?? 'shipped') as 'shipped' | 'planned' | 'none';
const showDivergences = Number(flag('divergences') ?? 5);

const bytes = readFileSync(file);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const entries = listZipEntries(buffer);
const scriptName = entries.find(e => e.endsWith('scripts/placement.js'));
if (!scriptName) throw new Error('no scripts/placement.js in the pack');
const script = new TextDecoder().decode(await extractFile(buffer, scriptName));
const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(script)![1]!);
const colliders: PlacementColliders | undefined = config.colliders;
if (!colliders) throw new Error('this pack has no collider grid (coloured-block export): nothing to walk');
const diagName = entries.find(e => e.endsWith('craftmatic-diagnostics.json'));
const diagnostics = diagName ? JSON.parse(new TextDecoder().decode(await extractFile(buffer, diagName))) : null;
const station = diagnostics?.coaster?.routes?.[0]?.station?.point;
if (Array.isArray(station) && station.length === 3 && !targets.some(t => t.label === 'coaster station')) targets.push({ label: 'coaster station', x: station[0], y: station[1], z: station[2] });

const dims = { width: colliders.width, height: colliders.height, length: colliders.length };
const cells = colliderSourceCells(colliders);
const shippedKeys = Object.keys(colliders.treads?.plans ?? {});
console.log(`${config.label}: ${dims.width}×${dims.height}×${dims.length} cells, ${cells.length} solid; shipped tread plans: ${shippedKeys.length ? shippedKeys.join(' ') : 'none'}; targets: ${targets.map(t => `${t.label} [${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}]`).join('; ') || 'none'}`);

const fmtPoint = (p: { x: number; y: number; z: number }): string => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
const describeTarget = (world: ReturnType<typeof buildWalkWorld>, pr: PointReach): string => {
  const head = `${pr.target.label}: BFS ${pr.bfs ? 'reached' : 'NOT reached'}, player ${pr.sim ? 'reached' : 'NOT reached'} (column ${pr.column.x}, ${pr.column.z} ±${pr.column.radius})`;
  if (pr.sim) {
    const pts = routeAsModelPoints(world, pr.route);
    const rises = pr.route.slice(1).map((s, i) => s.t - pr.route[i]!.t).filter(d => d !== 0);
    return `${head}; route ${pr.route.length} surfaces from ${fmtPoint(pts[0]!)}, ${rises.filter(d => d > 0).length} rise(s) up to ${blocksAt100(Math.max(0, ...rises), world.f)} blocks (at 100 %), ${rises.filter(d => d < 0).length} drop(s)`;
  }
  const near = pr.nearest100 ? `; nearest reached surface ${fmtPoint(pr.nearest100)} (model blocks at 100 %)` : '';
  const why = pr.refusal ? `; ${pr.refusal.kind}: ${pr.refusal.detail}` : '';
  return `${head}${near}${why}`;
};

const rows: unknown[] = [];
for (const pct of sizes) for (const r of turns) {
  const t0 = Date.now();
  const world = buildWalkWorld({ cells, dims, sizePct: pct, rotation: r, treads, shippedTreads: (p, q) => treadBlocksFor(colliders, p, q), targets });
  const cmp = compareReach(world, { edges: process.argv.includes('--all') ? 'all' : 'bfs' });
  const classes = cmp.classes;
  const points = targets.map(t => reachPoint(world, t));
  const ms = Date.now() - t0;
  rows.push({
    size: pct, turn: r, treads: { source: world.treadSource, blocks: world.treadBlocks.length },
    bfs: { surfaces: cmp.bfs.surfaces, columns: cmp.bfs.columns, highest100: cmp.highest.bfs100 },
    sim: { surfaces: cmp.sim.surfaces, columns: cmp.sim.columns, highest100: cmp.highest.sim100, edges: cmp.sim.edges },
    agreed: cmp.agreed, bfsOnly: cmp.bfsOnly.length, simOnly: cmp.simOnly.length, agreement: cmp.agreement, classes,
    targets: points.map(p => ({ label: p.target.label, bfs: p.bfs, sim: p.sim, route: p.route.length, refusal: p.refusal ?? null, nearest100: p.nearest100 })),
    ms,
  });
  console.log(`  ${String(pct).padStart(3)} % ${String(r).padStart(3)}°: treads ${world.treadSource} (${world.treadBlocks.length} blocks); highest on foot BFS ${cmp.highest.bfs100} / player ${cmp.highest.sim100} blocks (at 100 %); surfaces BFS ${cmp.bfs.surfaces} / player ${cmp.sim.surfaces}; agreed ${cmp.agreed}, BFS-only ${cmp.bfsOnly.length}, player-only ${cmp.simOnly.length} (${(cmp.agreement * 100).toFixed(2)} %); ${Object.entries(classes).map(([k, v]) => `${k} ${v}`).join(', ') || 'no disagreement'}; ${cmp.sim.edges.tried} edges tried; ${ms} ms`);
  for (const p of points) console.log(`         ${describeTarget(world, p)}`);
  for (const d of cmp.bfsOnly.slice(0, showDivergences)) {
    const m = routeAsModelPoints(world, [d.surface])[0]!;
    console.log(`         BFS-only ${fmtPoint(m)} (model blocks at 100 %; column ${d.surface.x}, ${d.surface.z} top ${d.top100}): ${d.attempts.map(a => `from (${a.from.x}, ${a.from.z}) at ${blocksAt100(a.from.t, world.f)}: ${a.reason} [${a.macro}]`).join('; ') || 'no reached neighbour tried it'}`);
  }
  for (const d of cmp.simOnly.slice(0, showDivergences)) {
    const m = routeAsModelPoints(world, [d.surface])[0]!;
    console.log(`         player-only ${fmtPoint(m)} (column ${d.surface.x}, ${d.surface.z} top ${d.top100}): the reach walk refuses every move onto it, the player made one`);
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ label: config.label, dims, cells: cells.length, targets, rows }, null, 1));
