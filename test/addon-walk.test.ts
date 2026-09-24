/**
 * THE WALK COLLIDES WITH WHAT THE PACK SHIPS, AND AGREES WITH THE REACH WALK.
 *
 * `engine/addon-walk.ts` is the pure half of the walkable preview: a
 * Minecraft-shaped player over the re-laid collider grid plus the tread plan,
 * and the questions that otherwise cost a device round. This suite pins:
 *
 *  1. THE PHYSICS against the numbers the game is known for: the 1.25-block
 *     jump (a 20/16 ledge is climbed, 21/16 is not), the auto-step (9/16
 *     walked, 10/16 needs a jump), standing headroom (29/16 passes, 28/16
 *     does not), the ground plane, sneaking at a lip, and contacts naming
 *     the block - and the tread - that clipped the move.
 *  2. FRAMES: model points and world points round-trip at every quarter turn
 *     and land in the same column `planColliderTreads` reports for a target.
 *  3. PARITY with `walkScaledColliders` on a synthetic stair house with
 *     planned treads (every surface the BFS reaches, the player reaches).
 *  4. PARITY ON REAL PACKS (skipped when they are absent): the coaster, its
 *     10261 sibling and the chalet at 100-400 %. The two models are compared
 *     surface by surface; every disagreement must be one of the two moves the
 *     reach walk is documented not to check (`structuralReason`), the highest
 *     reached surface must agree within a source block, and the coaster's
 *     station must be reached by both wherever the BFS reaches it. A
 *     disagreement outside those classes fails the test: it means one of the
 *     models is wrong in a way not yet understood.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  JUMP_PEAK, NO_INPUT, STEP_HEIGHT, WalkWorld, buildWalkWorld, compareReach, edgeMacros, highestReachable, modelPointToWorld, reachPoint, simulateEdge,
  simulateReach, spawnState, structuralReason, tickPlayer, worldPointToModel, type PlayerState, type WalkInput,
} from '../web/src/engine/addon-walk.js';
import { JUMP16, PLAYER_NEED16, QUARTER_TURNS, STEP16, planColliderTreads, type GridDims, type SourceCell } from '../web/src/engine/bedrock-collider-scale.js';
import { colliderSourceCells, treadBlocksFor, type PlacementColliders } from '../web/src/engine/bedrock-placement-pack.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';

// ─── Synthetic worlds ────────────────────────────────────────────────────────

/** A column solid from the ground up to `top16` sixteenths, cut into rows as the grid holds it. */
function solidTo(cells: SourceCell[], x: number, z: number, top16: number, from16 = 0): void {
  for (let row = Math.floor(from16 / 16); row * 16 < top16; row++) {
    const lo = Math.max(0, from16 - row * 16), hi = Math.min(16, top16 - row * 16);
    if (hi > lo) cells.push({ x, y: row, z, lo, hi });
  }
}

/** An open 8 x 8 pad with one column raised to `top16` at (4, 4). */
function ledge(top16: number, dims: GridDims = { width: 8, height: 4, length: 8 }): WalkWorld {
  const cells: SourceCell[] = [];
  solidTo(cells, 4, 4, top16);
  return buildWalkWorld({ cells, dims, sizePct: 100, rotation: 0, treads: 'none' });
}

/** A corridor along x at z = 4 with a ceiling leaving `gap16` above the ground, from x = 2 to 5. */
function corridor(gap16: number): WalkWorld {
  const cells: SourceCell[] = [];
  const dims = { width: 8, height: 4, length: 8 };
  for (let x = 2; x <= 5; x++) { solidTo(cells, x, 3, 48); solidTo(cells, x, 5, 48); solidTo(cells, x, 4, 48, gap16); }
  return buildWalkWorld({ cells, dims, sizePct: 100, rotation: 0, treads: 'none' });
}

/**
 * The tread suite's two-storey house in source cells: a floor plate, walls
 * with a doorway, a stair of brick-high risers (7/16) up to an upper floor
 * under a roof.
 */
function stairHouse(): { cells: SourceCell[]; dims: GridDims } {
  const dims = { width: 12, height: 6, length: 8 };
  const cells: SourceCell[] = [];
  for (let x = 0; x < 12; x++) for (let z = 0; z < 8; z++) {
    if (x === 0 && z === 4) { cells.push({ x, y: 0, z, lo: 0, hi: 3 }); continue; }   // the doorway on the floor plate
    if (x === 0 || x === 11 || z === 0 || z === 7) { solidTo(cells, x, z, 80); continue; } // walls
    cells.push({ x, y: 0, z, lo: 0, hi: 3 });          // floor plate
    cells.push({ x, y: 5, z, lo: 13, hi: 16 });        // roof slab
  }
  for (let x = 2; x <= 7; x++) for (const z of [2, 3]) solidTo(cells, x, z, 3 + 7 * (x - 1));
  for (let x = 8; x <= 10; x++) for (let z = 1; z <= 6; z++) cells.push({ x, y: 3, z, lo: 0, hi: 3 });
  return { cells, dims };
}

const hold = (x: number, z: number, extra: Partial<WalkInput> = {}): WalkInput => ({ move: { x, z }, jump: false, sneak: false, ...extra });

/** Run `n` ticks of one input, returning the states. */
function run(world: WalkWorld, s: PlayerState, input: WalkInput, n: number): PlayerState[] {
  const out: PlayerState[] = [];
  for (let i = 0; i < n; i++) { s = tickPlayer(world, s, input).state; out.push(s); }
  return out;
}

// ─── 1. Physics ──────────────────────────────────────────────────────────────

describe('player physics: the numbers the game is known for', () => {
  it('a standing jump peaks at 1.25 blocks and comes back to the ground', () => {
    const world = ledge(0);
    let s = spawnState(world, { x: 1.5, y: 0, z: 1.5 });
    s = tickPlayer(world, s, hold(0, 0, { jump: true })).state;
    let peak = s.y;
    for (let i = 0; i < 30; i++) { s = tickPlayer(world, s, NO_INPUT).state; peak = Math.max(peak, s.y); }
    expect(peak).toBeCloseTo(JUMP_PEAK, 9);
    expect(JUMP_PEAK).toBeGreaterThan(JUMP16 / 16);
    expect(JUMP_PEAK).toBeLessThan((JUMP16 + 1) / 16);
    expect(s.y).toBe(0);
    expect(s.onGround).toBe(true);
  });

  it('a fall stops on the ground plane, never below it', () => {
    const world = ledge(0);
    const states = run(world, spawnState(world, { x: 1.5, y: 5, z: 1.5 }), NO_INPUT, 60);
    expect(states.some(s => s.y < 0)).toBe(false);
    expect(states[states.length - 1]!.y).toBe(0);
    expect(states[states.length - 1]!.onGround).toBe(true);
  });

  it('a 9/16 rise is stepped up without a jump; a 10/16 rise needs one; a 21/16 rise is a wall', () => {
    const from = { x: 3, z: 4, t: 0 };
    for (const [top16, walk, jump] of [[STEP16, true, true], [STEP16 + 1, false, true], [JUMP16, false, true], [JUMP16 + 1, false, false]] as const) {
      const world = ledge(top16);
      const to = { x: 4, z: 4, t: top16 };
      const onlyWalk = edgeMacros(from, to).filter(m => m.name === 'walk');
      expect(simulateEdge(world, from, to, onlyWalk).ok, `walk onto ${top16}/16`).toBe(walk);
      expect(simulateEdge(world, from, to).ok, `any macro onto ${top16}/16`).toBe(jump);
    }
    expect(STEP_HEIGHT).toBe(STEP16 / 16);
  });

  it('standing headroom: a 29/16 gap is walked through, a 28/16 gap is not', () => {
    for (const [gap16, passes] of [[PLAYER_NEED16, true], [PLAYER_NEED16 - 1, false]] as const) {
      const world = corridor(gap16);
      const states = run(world, spawnState(world, { x: 0.5, y: 0, z: 4.5 }), hold(1, 0), 60);
      const far = states[states.length - 1]!;
      expect(far.x > 5, `gap ${gap16}/16`).toBe(passes);
      // The BFS sees the same: a surface only where the player's height is clear.
      expect(world.grid.surfaces(3, 4).includes(0)).toBe(passes);
    }
  });

  it('sneaking at a lip stops the player short of a drop deeper than the step, and walking off it drifts about a block', () => {
    const cells: SourceCell[] = [];
    for (let x = 0; x < 4; x++) for (let z = 0; z < 8; z++) solidTo(cells, x, z, 32);
    const world = buildWalkWorld({ cells, dims: { width: 8, height: 4, length: 8 }, sizePct: 100, rotation: 0, treads: 'none' });
    const sneak = run(world, spawnState(world, { x: 1.5, y: 2, z: 4.5 }), hold(1, 0, { sneak: true }), 120);
    const stopped = sneak[sneak.length - 1]!;
    expect(stopped.y).toBe(2);
    expect(stopped.onGround).toBe(true);
    expect(stopped.x).toBeGreaterThan(4);       // the box overhangs the lip...
    expect(stopped.x).toBeLessThan(4.3 + 1e-9); // ...but its centre stays within 0.3 of it: still supported
    const walk = run(world, spawnState(world, { x: 3.0, y: 2, z: 4.5 }), hold(1, 0), 60);
    const landed = walk.find(s => s.onGround && s.y === 0)!;
    expect(landed).toBeDefined();
    expect(landed.x).toBeGreaterThan(4.6);
    expect(landed.x).toBeLessThan(6);
  });

  it('contacts name the solid that clipped the move, and whether it is a tread', () => {
    const { cells, dims } = stairHouse();
    const world = buildWalkWorld({ cells, dims, sizePct: 300, rotation: 0, treads: 'planned' });
    expect(world.treadSource).toBe('planned');
    expect(world.treadBlocks.length).toBeGreaterThan(0);
    // The topmost tread block of the first tread column (a run fills a column from its floor up to the tread's top).
    const first = world.treadBlocks[0]!;
    const tread = world.treadBlocks.filter(b => b.x === first.x && b.z === first.z).sort((p, q) => q.y - p.y)[0]!;
    // Drop the player onto the tread from above: the y contact is that block, flagged.
    const s = spawnState(world, { x: tread.x + 0.5, y: tread.y + tread.hi / 16 + 0.5, z: tread.z + 0.5 });
    let r = tickPlayer(world, s, NO_INPUT);
    for (let i = 0; i < 20 && !r.collided.below; i++) r = tickPlayer(world, r.state, NO_INPUT);
    expect(r.collided.below).toBe(true);
    const c = r.contacts.find(k => k.axis === 'y')!;
    expect(c.solid.tread).toBe(true);
    expect(c.solid.block).toMatchObject({ x: tread.x, row: tread.y, z: tread.z });
    // Walking into a wall names the wall, not a tread.
    const w = spawnState(world, { x: 3.5, y: 0.5625, z: 3.5 });
    let hit = tickPlayer(world, w, hold(0, -1));
    for (let i = 0; i < 40 && !hit.collided.z; i++) hit = tickPlayer(world, hit.state, hold(0, -1));
    expect(hit.collided.z).toBe(true);
    expect(hit.contacts.find(k => k.axis === 'z')!.solid.tread).toBe(false);
  });
});

// ─── 2. Frames ───────────────────────────────────────────────────────────────

describe('frames', () => {
  const dims = { width: 42, height: 44, length: 21 };
  const station = { label: 'station', x: 24.66, y: 3.3, z: 9.26 };
  it('model and world points round-trip at every size and turn, and land in the column the planner reports', () => {
    const { cells } = stairHouse();
    for (const f of [1, 1.5, 2, 3, 4]) for (const r of QUARTER_TURNS) {
      const w = modelPointToWorld(station, dims, f, r);
      const back = worldPointToModel(w, dims, f, r);
      expect(back.x).toBeCloseTo(station.x, 9); expect(back.y).toBeCloseTo(station.y, 9); expect(back.z).toBeCloseTo(station.z, 9);
      const plan = planColliderTreads(cells, dims, f * 100, r, [station]);
      expect({ x: Math.floor(w.x), z: Math.floor(w.z) }).toEqual({ x: plan.targets![0]!.column.x, z: plan.targets![0]!.column.z });
    }
  });
  it('refuses a size below 100 %', () => {
    expect(() => buildWalkWorld({ cells: [], dims, sizePct: 75, rotation: 0 })).toThrow(/100 %/);
  });
});

// ─── 3. Synthetic parity ─────────────────────────────────────────────────────

describe('parity with the reach walk on the stair house', () => {
  const { cells, dims } = stairHouse();
  for (const pct of [100, 150, 200, 300, 400]) for (const r of QUARTER_TURNS) {
    it(`${pct} % / ${r}°: every surface the BFS reaches, the player reaches (treads planned)`, () => {
      const world = buildWalkWorld({ cells, dims, sizePct: pct, rotation: r, treads: 'planned' });
      const cmp = compareReach(world);
      const unexplained = cmp.bfsOnly.filter(d => d.class === 'unexplained');
      expect(unexplained.map(d => ({ ...d.surface, top100: d.top100, reasons: d.attempts.map(a => a.reason) })), 'divergences outside the documented classes').toEqual([]);
      expect(cmp.simOnly).toEqual([]);
      expect(cmp.highest.sim100).toBe(cmp.highest.bfs100);
      if (pct >= 300) expect(cmp.highest.bfs100).toBeGreaterThanOrEqual(3);   // the upper floor, restored by treads
    });
  }
  it('the upper floor is a reachable point at 300 % with treads and refused as a rise without them', () => {
    const upper = { label: 'upper floor', x: 9.5, y: 51 / 16, z: 3.5 };
    const withTreads = reachPoint(buildWalkWorld({ cells, dims, sizePct: 300, rotation: 0, treads: 'planned' }), upper);
    expect(withTreads.bfs).toBe(true);
    expect(withTreads.sim).toBe(true);
    expect(withTreads.route.length).toBeGreaterThan(2);
    const bare = reachPoint(buildWalkWorld({ cells, dims, sizePct: 300, rotation: 0, treads: 'none' }), upper);
    expect(bare.bfs).toBe(false);
    expect(bare.sim).toBe(false);
    expect(bare.refusal?.kind).toBe('rise');
    expect(bare.nearest).not.toBeNull();
  });
  it('highestReachable reports both models', () => {
    const world = buildWalkWorld({ cells, dims, sizePct: 200, rotation: 0, treads: 'planned' });
    const h = highestReachable(world, simulateReach(world));
    expect(h.sim!.blocks100).toBe(h.bfs.blocks100);
  });
});

// ─── 4. Real packs ───────────────────────────────────────────────────────────

const PACKS = [
  { file: 'output/bedrock-entity-qa/10303-owncars.mcaddon', station: true },
  { file: 'output/bedrock-entity-qa/10261-owncars.mcaddon', station: true },
  { file: 'output/bedrock-entity-qa/910004-runtime-door.mcaddon', station: false },
].filter(p => existsSync(p.file));

async function readPack(file: string): Promise<{ label: string; colliders: PlacementColliders; station: { x: number; y: number; z: number } | null }> {
  const b = readFileSync(file);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const entries = listZipEntries(buf);
  const script = new TextDecoder().decode(await extractFile(buf, entries.find(e => e.endsWith('scripts/placement.js'))!));
  const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(script)![1]!);
  const diagName = entries.find(e => e.endsWith('craftmatic-diagnostics.json'));
  const diag = diagName ? JSON.parse(new TextDecoder().decode(await extractFile(buf, diagName))) : null;
  const p = diag?.coaster?.routes?.[0]?.station?.point;
  return { label: config.label, colliders: config.colliders, station: Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : null };
}

describe.skipIf(PACKS.length === 0)('parity with the reach walk on real packs', () => {
  for (const pack of PACKS) for (const pct of [100, 150, 200, 300, 400]) {
    it(`${pack.file.split('/').pop()} at ${pct} %: every disagreement is a move the walk is documented not to check`, async () => {
      const { colliders, station } = await readPack(pack.file);
      const dims = { width: colliders.width, height: colliders.height, length: colliders.length };
      const cells = colliderSourceCells(colliders);
      const world = buildWalkWorld({ cells, dims, sizePct: pct, rotation: 0, treads: colliders.treads ? 'shipped' : 'planned', shippedTreads: (p, r) => treadBlocksFor(colliders, p, r) });
      const cmp = compareReach(world);
      // Every disagreement is explained by the grid (the classes the walk is documented not to check) or lies beyond one that is.
      const unexplained = cmp.bfsOnly.filter(d => d.class === 'unexplained');
      expect(unexplained.slice(0, 10).map(d => ({ ...d.surface, top100: d.top100, attempts: d.attempts.map(a => `${a.from.x},${a.from.z}@${a.from.t}:${a.reason}`) })), `${unexplained.length} divergence(s) outside the documented classes; classes ${JSON.stringify(cmp.classes)}`).toEqual([]);
      for (const d of cmp.bfsOnly) for (const a of d.attempts) expect(structuralReason(world, a.from, a.to), `attempt ${a.from.x},${a.from.z}@${a.from.t} -> ${a.to.x},${a.to.z}@${a.to.t}`).not.toBeNull();
      expect(cmp.simOnly).toEqual([]);
      // The highest surface on foot agrees to within one source block at 100 %.
      expect(Math.abs(cmp.highest.sim100 - cmp.highest.bfs100)).toBeLessThanOrEqual(1);
      if (pack.station && station) {
        const pr = reachPoint(world, { label: 'coaster station', ...station });
        // The coaster's station is reached by the BFS at every size (bare at 100 %, with treads above); 10261's is not reached by either.
        expect(pr.sim, `the player's verdict on the station must match the BFS's: ${pr.refusal?.detail ?? ''}`).toBe(pr.bfs);
        if (pr.sim) expect(pr.route.length).toBeGreaterThan(1);
      }
    }, 120_000);
  }
});

// ─── Entity collision and door toggling (the add-on walk's interactivity) ────

describe('entitySolids: a static entity collision box the live player bumps into', () => {
  it('blocks a walk through it, but never the reach BFS (which only ever consults the LEGO grid)', () => {
    const dims: GridDims = { width: 8, height: 4, length: 8 };
    // An open floor (a thin slab so the player has something to stand on) with
    // one entity box (a "standing figure", 0.6 x 1.8) parked at (4, 4).
    const cells: SourceCell[] = [];
    solidTo(cells, 4, 0, 16);
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) if (x !== 4 || z !== 4) solidTo(cells, x, 0, 16);
    const figureBox = { key: 'fig', x0: 3.7, y0: 1, z0: 3.7, x1: 4.3, y1: 2.8, z1: 4.3 };
    const world = buildWalkWorld({ cells, dims, sizePct: 100, rotation: 0, treads: 'none', entitySolids: [figureBox] });
    // The reach BFS is unaffected: it still walks the plain floor as if the entity were not there.
    const reach = world.reach();
    expect(reach.surfaces).toBeGreaterThan(0);
    // A player standing right at the entity's column, trying to walk through it, is blocked.
    let s = spawnState(world, { x: 4, y: 1, z: 2 });
    const input: WalkInput = { move: { x: 0, z: 1 }, jump: false, sneak: false };
    for (let i = 0; i < 60; i++) s = tickPlayer(world, s, input).state;
    expect(s.z).toBeLessThan(3.7);
  });

  it('does not appear at all with no entitySolids option (the default, unaffected preview)', () => {
    const dims: GridDims = { width: 8, height: 4, length: 8 };
    const cells: SourceCell[] = [];
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) solidTo(cells, x, 0, 16);
    const world = buildWalkWorld({ cells, dims, sizePct: 100, rotation: 0, treads: 'none' });
    let s = spawnState(world, { x: 4, y: 1, z: 2 });
    const input: WalkInput = { move: { x: 0, z: 1 }, jump: false, sneak: false };
    for (let i = 0; i < 60; i++) s = tickPlayer(world, s, input).state;
    expect(s.z).toBeGreaterThan(5);
  });
});

describe('WalkWorld.setDoorOpen: a vanilla door candidate toggling its collision', () => {
  it('drops the column\'s colliders in the opening while open, and restores them when closed', () => {
    const dims: GridDims = { width: 8, height: 4, length: 8 };
    const cells: SourceCell[] = [];
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) solidTo(cells, x, 0, 16);
    // A 1x2 "door" opening at (4, 4), y in [1, 3): a wall column across the corridor.
    solidTo(cells, 4, 4, 48, 16);
    const world = buildWalkWorld({ cells, dims, sizePct: 100, rotation: 0, treads: 'none' });
    expect(world.isDoorOpen('door0')).toBe(false);

    const walkThrough = (): number => {
      let s = spawnState(world, { x: 4, y: 1, z: 2 });
      const input: WalkInput = { move: { x: 0, z: 1 }, jump: false, sneak: false };
      for (let i = 0; i < 80; i++) s = tickPlayer(world, s, input).state;
      return s.z;
    };
    expect(walkThrough()).toBeLessThan(4);

    world.setDoorOpen('door0', 4, 4, 1, true, 2);
    expect(world.isDoorOpen('door0')).toBe(true);
    expect(walkThrough()).toBeGreaterThan(5);

    world.setDoorOpen('door0', 4, 4, 1, false);
    expect(world.isDoorOpen('door0')).toBe(false);
    expect(walkThrough()).toBeLessThan(4);
  });

  it('never affects the reach BFS, which grades the model by its shipped colliders alone', () => {
    const dims: GridDims = { width: 8, height: 4, length: 8 };
    const cells: SourceCell[] = [];
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) solidTo(cells, x, 0, 16);
    solidTo(cells, 4, 4, 48, 16);
    const world = buildWalkWorld({ cells, dims, sizePct: 100, rotation: 0, treads: 'none' });
    const before = world.reach().surfaces;
    world.setDoorOpen('door0', 4, 4, 1, true, 2);
    expect(world.reach().surfaces).toBe(before);
  });
});
