/**
 * Can a player standing near a moving part actually tap it? For a built pack:
 * lay its shipped colliders in a host world, spawn every moving part where the
 * placement puts it, and from every spot a player can stand within touch
 * reach, aim at each of the part's closed tap boxes and tap it through the
 * REAL runtime (`scripts/interactives.js`, run by `runtimeHost`).
 *
 * A spot counts as REACHABLE when the eyes are within `reach` of the box and
 * no other part's tap box or seat lies on the ray in front of it (Bedrock
 * gives the tap to the nearest box on the ray). It counts as ACCEPTED when the
 * runtime then toggled the part. A part with reachable spots and no accepted
 * one is what device 2026-09-24e saw on 76457's Door 1: label and button
 * shown, nothing moves (the through-wall filter refused every tap).
 *
 * Collider blocks have no selection box on the device, so they never catch a
 * tap themselves; only the runtime's own wall test can refuse one.
 */
import { extractMatching } from '../web/src/engine/zip-utils.js';
import { hitGroupName, seatHitBox, worldHitBox, type HitBox, type InteractiveRuntimeConfig, type WorldHitBox } from '../web/src/engine/bedrock-interactives.js';
import { colliderSourceCells } from '../web/src/engine/bedrock-placement-pack.js';
import { runtimeHost } from './_ix-host.js';

export interface TapAuditPart {
  label: string;
  /** Standing spots within reach from which some closed tap box is the first thing on the ray. */
  reachable: number;
  /** Of those, the spots from which the runtime toggled the part. */
  accepted: number;
  /** Tap boxes no standing spot reaches at all (too high, buried in colliders or behind another part). */
  unreachedBoxes: number;
  boxes: number;
  /**
   * Of the accepted spots, those from which the part also CLOSES again: the
   * second tap, aimed at the OPEN part's tap boxes, is accepted too. From a
   * spot that sees only the closed leaf, the open one can stand behind a wall
   * and the runtime's line-of-sight filter refuses the closing tap (71040's
   * Door 1 on the Pixel, GameTest 2026-09-25). A turnable only counts steps.
   */
  closable: number;
  /** With `trace`: every reachable spot (feet), whether the tap there was accepted, and whether the part closed again from it. */
  spots?: Array<{ at: [number, number, number]; ok: boolean; closes: boolean }>;
}

export interface TapAudit { parts: TapAuditPart[] }

interface Actor { typeId: string; label: string; x: number; y: number; z: number; interactive?: number }

const utf8 = new TextDecoder();

/** The ray from `o` along unit `d` against a box: entry distance, or Infinity. */
function rayBox(o: number[], d: number[], b: WorldHitBox): number {
  let t0 = -Infinity, t1 = Infinity;
  const lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) { if (o[k]! < lo[k]! || o[k]! > hi[k]!) return Infinity; continue; }
    const a = (lo[k]! - o[k]!) / d[k]!, c = (hi[k]! - o[k]!) / d[k]!;
    t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
  }
  return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : Infinity;
}

export async function auditPackTaps(mcaddon: ArrayBuffer, opts: { reach?: number; trace?: boolean } = {}): Promise<TapAudit> {
  const reach = opts.reach ?? 3;
  const found = await extractMatching(mcaddon, n => /scripts\/(placement|interactives)\.js$/.test(n) || /_BP\/entities\/[^/]+\.json$/.test(n));
  let placement: { actors?: Actor[]; colliders?: { width: number; height: number; length: number; runs: string } } = {};
  let cfg: InteractiveRuntimeConfig | null = null;
  const groups = new Map<string, Record<string, unknown>>();
  for (const [name, data] of found) {
    const text = utf8.decode(data);
    const m = /^const CONFIG = (\{.*\});$/m.exec(text);
    if (name.endsWith('placement.js')) { if (m) placement = JSON.parse(m[1]!); continue; }
    if (name.endsWith('interactives.js')) { if (m) cfg = JSON.parse(m[1]!); continue; }
    try { const e = JSON.parse(text)['minecraft:entity']; if (e?.description?.identifier) groups.set(e.description.identifier, e.component_groups ?? {}); } catch { /* not an entity */ }
  }
  if (!cfg || !placement.actors) return { parts: [] };
  const actors = placement.actors;
  const cells = placement.colliders ? colliderSourceCells(placement.colliders as Parameters<typeof colliderSourceCells>[0]) : [];
  const solid = new Map<string, [number, number]>();
  for (const c of cells) solid.set(`${c.x},${c.y},${c.z}`, [c.lo, c.hi]);
  const parts = actors.filter(a => a.interactive !== undefined);
  const boxesOf = (a: Actor, open = false): WorldHitBox[] => {
    const g = groups.get(a.typeId)?.[hitGroupName(0, 100, open)] as { 'minecraft:custom_hit_test'?: { hitboxes?: HitBox[] } } | undefined;
    return (g?.['minecraft:custom_hit_test']?.hitboxes ?? []).map(b => worldHitBox([a.x, a.y, a.z], b));
  };
  const seatBoxes = actors.filter(a => /_seat(_\d+)?$/.test(a.typeId.replace(/^[^:]*:/, ''))).map(a => seatHitBox([a.x, a.y, a.z]));
  const allBoxes = parts.map(boxesOf);

  // Standing spots: a floor surface (a collider top, or the ground at y 0 outside the grid's cells) with 1.8 blocks of air over it.
  const W = placement.colliders?.width ?? 0, L = placement.colliders?.length ?? 0, H = placement.colliders?.height ?? 0;
  const occupied = (x: number, z: number, y0: number, y1: number): boolean => {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      const s = solid.get(`${x},${y},${z}`);
      if (s && y + s[1] / 16 > y0 + 1e-6 && y + s[0] / 16 < y1 - 1e-6) return true;
    }
    return false;
  };
  const spots: Array<[number, number, number]> = [];
  for (let x = -3; x < W + 3; x++) for (let z = -3; z < L + 3; z++) {
    const tops = new Set<number>([0]);
    for (let y = 0; y < H; y++) { const s = solid.get(`${x},${y},${z}`); if (s) tops.add(y + s[1] / 16); }
    for (const t of tops) if (!occupied(x, z, t, t + 1.8)) spots.push([x + 0.5, t, z + 0.5]);
  }

  const out: TapAuditPart[] = [];
  for (let pi = 0; pi < parts.length; pi++) {
    const a = parts[pi]!;
    const own = allBoxes[pi]!;
    const ownOpen = boxesOf(a, true);
    const others = [...allBoxes.filter((_, j) => j !== pi).flat(), ...seatBoxes];
    /** A fresh host with this part spawned closed (after a refused closing tap the old one is left open). */
    const fresh = (): { h: ReturnType<typeof runtimeHost>; e: ReturnType<ReturnType<typeof runtimeHost>['spawn']> } => {
      const h = runtimeHost(cfg!);
      for (const [key, [lo, hi]] of solid) { const [x, y, z] = key.split(',').map(Number) as [number, number, number]; h.setCollider(x, y, z, lo, hi); }
      const e = h.spawn(a.interactive!, { x: 0, y: 0, z: 0 }, 1, 0, { x: a.x, y: a.y, z: a.z });
      h.sync();
      return { h, e };
    };
    let { h, e } = fresh();
    /** The first box of `list` in reach from `eye` with nothing else on the ray in front of it, and where to aim. */
    const aimable = (eye: number[], list: WorldHitBox[]): { bi: number; c: number[] } | null => {
      for (let bi = 0; bi < list.length; bi++) {
        const b = list[bi]!;
        const c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
        const v = [c[0]! - eye[0]!, c[1]! - eye[1]!, c[2]! - eye[2]!], n = Math.hypot(v[0]!, v[1]!, v[2]!);
        if (n > reach + 0.5) continue;
        const d = v.map(q => q / n);
        const tHit = rayBox(eye, d, b);
        if (tHit > reach || others.some(o => rayBox(eye, d, o) < tHit - 1e-6)) continue;
        return { bi, c };
      }
      return null;
    };
    let reachable = 0, accepted = 0, closable = 0;
    const reached = new Set<number>();
    const trace: Array<{ at: [number, number, number]; ok: boolean; closes: boolean }> = [];
    for (const [sx, sy, sz] of spots) {
      const eye = [sx, sy + 1.62, sz];
      let spotReach = false, spotOk = false, closes = false;
      own.forEach((b, bi) => {
        if (spotOk) return;
        const hit = aimable(eye, [b]);
        if (!hit) return;
        spotReach = true; reached.add(bi);
        const before = e.getDynamicProperty('craftmatic:ix_open') === true;
        const angleBefore = Number(e.getDynamicProperty('craftmatic:ix_angle') ?? 0);
        h.aim({ x: eye[0]!, y: eye[1]!, z: eye[2]! }, { x: hit.c[0]!, y: hit.c[1]!, z: hit.c[2]! });
        h.tap(e);
        const after = e.getDynamicProperty('craftmatic:ix_open') === true;
        const angleAfter = Number(e.getDynamicProperty('craftmatic:ix_angle') ?? 0);
        if (after === before && angleAfter === angleBefore) return;
        spotOk = true;
        if (after === before) { closes = true; return; } // a turnable steps; there is nothing to close
        // Close it again from the same spot, aimed at the OPEN part's boxes (what a player sees now).
        const back = aimable(eye, ownOpen);
        if (back) {
          h.aim({ x: eye[0]!, y: eye[1]!, z: eye[2]! }, { x: back.c[0]!, y: back.c[1]!, z: back.c[2]! });
          h.tap(e);
          closes = (e.getDynamicProperty('craftmatic:ix_open') === true) === before;
        }
        if (!closes) ({ h, e } = fresh());
      });
      if (spotReach) { reachable++; trace.push({ at: [sx, sy, sz], ok: spotOk, closes: spotOk && closes }); }
      if (spotOk) accepted++;
      if (spotOk && closes) closable++;
    }
    out.push({ label: a.label, reachable, accepted, closable, unreachedBoxes: own.length - reached.size, boxes: own.length, ...(opts.trace ? { spots: trace } : {}) });
  }
  return { parts: out };
}
