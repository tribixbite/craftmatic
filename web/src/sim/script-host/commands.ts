/**
 * The slash commands the packs run through `runCommand`, executed on the
 * engine: `tickingarea add|remove`, `structure load`, `ride ... start_riding`,
 * `controlscheme`, `setblock`, and `tp` for scenarios. A command the
 * simulator does not implement is Unmodelled (recorded and thrown), never a
 * silent success.
 */

import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import { forEachStructureBlock, type StructureRotation } from '../world/mcstructure.js';
import type { BlockStates } from '../world/block-types.js';
import { entityMatches, sortQuery, teleport, type FacadeHost } from './facades.js';
import { unmodelled } from './unmodelled.js';

/** Most chunks one ticking area may cover (Bedrock refuses a larger `tickingarea add`). */
export const TICKING_AREA_MAX_CHUNKS = 100;

/** A command's result, as `runCommand` returns it. */
export interface CommandResult { successCount: number }

/** Split a command line on spaces, keeping `[...]` selector arguments and quoted strings whole. */
export function commandTokens(line: string): string[] {
  const out: string[] = [];
  let cur = '', depth = 0, quote = false;
  for (const ch of line.trim()) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '[') depth++;
    if (!quote && ch === ']') depth--;
    if (ch === ' ' && depth === 0 && !quote) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A coordinate token (`12`, `~`, `~1.5`) relative to a base. */
const coord = (t: string | undefined, base: number): number => {
  if (t === undefined) throw new SyntaxError('missing coordinate');
  if (t.startsWith('~')) return base + (t.length > 1 ? Number(t.slice(1)) : 0);
  const v = Number(t);
  if (!Number.isFinite(v)) throw new SyntaxError(`bad coordinate ${t}`);
  return v;
};

/** Resolve a target selector to engine entities. */
export function selectEntities(engine: SimEngine, selector: string, source: SimEntity | undefined, dimension: string): SimEntity[] {
  if (selector === '@s') return source ? [source] : [];
  const m = /^@([aeprs])(?:\[(.*)\])?$/.exec(selector);
  if (!m) return engine.players.filter(p => p.nameTag === selector);
  const args: Record<string, string> = {};
  for (const part of (m[2] ?? '').split(',').map(s => s.trim()).filter(Boolean)) { const [k, v] = part.split('='); args[k!.trim()] = (v ?? '').trim(); }
  const base = source?.location ?? { x: 0, y: 0, z: 0 };
  const at = { x: args['x'] !== undefined ? coord(args['x'], base.x) : base.x, y: args['y'] !== undefined ? coord(args['y'], base.y) : base.y, z: args['z'] !== undefined ? coord(args['z'], base.z) : base.z };
  let list = m[1] === 'a' || m[1] === 'p' || m[1] === 'r' ? engine.players.filter(p => p.valid) : engine.loadedEntities(dimension);
  const q: Record<string, unknown> = { location: at };
  if (args['type']) q['type'] = args['type'].replace(/^!/, '');
  if (args['family']) q['families'] = [args['family']];
  if (args['tag']) q['tags'] = [args['tag']];
  if (args['name']) q['name'] = args['name'].replace(/^"|"$/g, '');
  if (args['r']) q['maxDistance'] = Number(args['r']);
  if (args['rm']) q['minDistance'] = Number(args['rm']);
  list = list.filter(e => entityMatches(e, q));
  if (m[1] === 'p') return sortQuery(list, { location: at, closest: 1 });
  if (args['c']) return sortQuery(list, { location: at, closest: Number(args['c']) });
  return list;
}

/** Parse `["a"=1,"b"=true]` block states. */
function parseStates(t: string | undefined): BlockStates {
  const out: BlockStates = {};
  if (!t || !t.startsWith('[')) return out;
  for (const part of t.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    const key = k!.replace(/"/g, ''), raw = (v ?? '').trim();
    out[key] = raw === 'true' ? true : raw === 'false' ? false : raw.startsWith('"') ? raw.replace(/"/g, '') : Number(raw);
  }
  return out;
}

/** Run one command as `source` (or the dimension) in `dimension`. */
export function runCommand(host: FacadeHost, dimension: string, line: string, source?: SimEntity): CommandResult {
  const { engine, timeline } = host;
  const t = commandTokens(line.replace(/^\//, ''));
  const name = t[0] ?? '';
  const src = timeline.callerSource();
  timeline.add('command', line, src ? { source: src } : {});
  const base = source?.location ?? { x: 0, y: 0, z: 0 };
  switch (name) {
    case 'tickingarea': {
      if (t[1] === 'add') {
        const x0 = coord(t[2], base.x), z0 = coord(t[4], base.z), x1 = coord(t[5], base.x), z1 = coord(t[7], base.z);
        const areaName = t[8] ?? `area${engine.tickingAreas.size}`;
        const chunks = ((Math.floor(Math.max(x0, x1)) >> 4) - (Math.floor(Math.min(x0, x1)) >> 4) + 1) * ((Math.floor(Math.max(z0, z1)) >> 4) - (Math.floor(Math.min(z0, z1)) >> 4) + 1);
        if (chunks > TICKING_AREA_MAX_CHUNKS) return { successCount: 0 };
        engine.tickingAreas.set(areaName, { name: areaName, dimension, x0, z0, x1, z1 });
        return { successCount: 1 };
      }
      if (t[1] === 'remove') return { successCount: engine.tickingAreas.delete(t[2] ?? '') ? 1 : 0 };
      if (t[1] === 'remove_all') { const n = engine.tickingAreas.size; engine.tickingAreas.clear(); return { successCount: n ? 1 : 0 }; }
      break;
    }
    case 'structure': {
      if (t[1] !== 'load') break;
      const s = engine.structures.get(t[2] ?? '');
      if (!s) return { successCount: 0 };
      const x = Math.floor(coord(t[3], base.x)), y = Math.floor(coord(t[4], base.y)), z = Math.floor(coord(t[5], base.z));
      const rot = Number(/^(\d+)_degrees$/.exec(t[6] ?? '0_degrees')?.[1] ?? 0) as StructureRotation;
      const w = engine.dimension(dimension);
      // The game loads a structure only into loaded chunks.
      const turned = rot % 180 ? { x: s.size.z, z: s.size.x } : { x: s.size.x, z: s.size.z };
      for (let cx = x >> 4; cx <= (x + turned.x - 1) >> 4; cx++) for (let cz = z >> 4; cz <= (z + turned.z - 1) >> 4; cz++) if (!w.isLoaded(cx * 16, cz * 16)) return { successCount: 0 };
      forEachStructureBlock(s, rot, (dx, dy, dz, b) => {
        let p;
        try { p = host.resolvePermutation(b.typeId, b.states); }
        catch { p = host.resolvePermutation('minecraft:air'); timeline.add('content-log', `[Structure] ${t[2]}: unknown block ${b.typeId} placed as air`); }
        w.setPermutation(x + dx, y + dy, z + dz, p);
      });
      return { successCount: 1 };
    }
    case 'ride': {
      const riders = selectEntities(engine, t[1] ?? '@s', source, dimension);
      if (t[2] !== 'start_riding') break;
      const mounts = selectEntities(engine, t[3] ?? '', source, dimension);
      const mount = mounts[0];
      if (!mount) return { successCount: 0 };
      let n = 0;
      for (const r of riders) {
        if (t[4] === 'teleport_rider' || t[4] === undefined) r.location = { ...mount.location };
        if (mount.addRider(r, engine.tick).ok) n++;
      }
      return { successCount: n };
    }
    case 'controlscheme': {
      // `controlscheme <target> clear` or `controlscheme <target> set <scheme>` (the scheme is the FOURTH token).
      const scheme = t[2] === 'set' ? t[3] : t[2];
      for (const p of selectEntities(engine, t[1] ?? '@s', source, dimension)) if (p.isPlayer) { if (scheme === 'clear' || scheme === undefined) delete host.playerState(p).controlScheme; else host.playerState(p).controlScheme = scheme; }
      return { successCount: 1 };
    }
    case 'setblock': {
      const x = Math.floor(coord(t[1], base.x)), y = Math.floor(coord(t[2], base.y)), z = Math.floor(coord(t[3], base.z));
      const id = (t[4] ?? '').includes(':') ? t[4]! : `minecraft:${t[4]}`;
      const w = engine.dimension(dimension);
      if (!w.isLoaded(x, z)) return { successCount: 0 };
      w.setPermutation(x, y, z, host.resolvePermutation(id, parseStates(t[5])));
      return { successCount: 1 };
    }
    case 'tp': case 'teleport': {
      const targets = selectEntities(engine, t[1] ?? '@s', source, dimension);
      const to = { x: coord(t[2], base.x), y: coord(t[3], base.y), z: coord(t[4], base.z) };
      for (const e of targets) teleport(host, e, to);
      return { successCount: targets.length };
    }
    default: break;
  }
  throw unmodelled(timeline, `command:${name}${t[1] && /^[a-z_]+$/.test(t[1]) ? ` ${t[1]}` : ''}`);
}
