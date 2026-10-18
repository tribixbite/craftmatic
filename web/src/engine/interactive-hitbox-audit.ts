/**
 * Do a built pack's tap boxes keep to their own parts? Reads what the pack
 * SHIPS - each moving part's `minecraft:custom_hit_test` groups for turn 0 at
 * 100 %, closed and open (`hitGroupName`), placed at its actor's point - and
 * reports every pair of parts whose boxes overlap in any combination of
 * states, and every box that overlaps a seat's own tap box. Device 2026-09-24d:
 * a window's box took the taps meant for the chair beside it, a tap at a window
 * opened the door next to it.
 *
 * Pure over the archive's bytes (zip-utils), so vitest and a CLI
 * (`scripts/_ix_hitbox_audit.ts`) run it unchanged.
 */

import { extractMatching } from './zip-utils.js';
import { hitBoxesOverlap, hitGroupName, seatHitBox, worldHitBox, type HitBox, type WorldHitBox } from './bedrock-interactives.js';

export interface HitboxAudit {
  parts: number;
  seats: number;
  boxes: number;
  /** Pairs of parts (labels) whose boxes overlap, with the states that did. */
  partOverlaps: string[];
  /** Parts whose box overlaps a seat's tap box. */
  seatOverlaps: string[];
  /** Parts that shipped no tap boxes at all (an older pack, or a failure). */
  missing: string[];
}

const utf8 = new TextDecoder();

export async function auditPackHitboxes(mcaddon: ArrayBuffer): Promise<HitboxAudit> {
  const found = await extractMatching(mcaddon, n => /scripts\/placement\.js$/.test(n) || /_BP\/entities\/[^/]+\.json$/.test(n));
  let config: { actors?: Array<{ typeId: string; label: string; x: number; y: number; z: number; interactive?: number }> } = {};
  const behaviors = new Map<string, { groups: Record<string, Record<string, unknown>> }>();
  for (const [name, data] of found) {
    const text = utf8.decode(data);
    if (name.endsWith('placement.js')) { const m = /^const CONFIG = (\{.*\});$/m.exec(text); if (m) config = JSON.parse(m[1]!); continue; }
    try {
      const e = JSON.parse(text)['minecraft:entity'];
      if (e?.description?.identifier) behaviors.set(e.description.identifier, { groups: e.component_groups ?? {} });
    } catch { /* not an entity file */ }
  }
  const actors = config.actors ?? [];
  const parts = actors.filter(a => a.interactive !== undefined);
  const seats = actors.filter(a => /_seat(_\d+)?$/.test(a.typeId.replace(/^[^:]*:/, '')));
  const boxesOf = (a: typeof parts[number], open: boolean): WorldHitBox[] => {
    const g = behaviors.get(a.typeId)?.groups[hitGroupName(0, 100, open)] as { 'minecraft:custom_hit_test'?: { hitboxes?: HitBox[] } } | undefined;
    return (g?.['minecraft:custom_hit_test']?.hitboxes ?? []).map(b => worldHitBox([a.x, a.y, a.z], b));
  };
  const audit: HitboxAudit = { parts: parts.length, seats: seats.length, boxes: 0, partOverlaps: [], seatOverlaps: [], missing: [] };
  const all = parts.map(a => ({ a, closed: boxesOf(a, false), open: boxesOf(a, true) }));
  for (const p of all) { audit.boxes += p.closed.length + p.open.length; if (!p.closed.length) audit.missing.push(p.a.label); }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const states: string[] = [];
    for (const [si, bi] of [['closed', all[i]!.closed], ['open', all[i]!.open]] as const) for (const [sj, bj] of [['closed', all[j]!.closed], ['open', all[j]!.open]] as const)
      if (bi.some(x => bj.some(y => hitBoxesOverlap(x, y)))) states.push(`${si}/${sj}`);
    if (states.length) audit.partOverlaps.push(`${all[i]!.a.label} x ${all[j]!.a.label} (${states.join(', ')})`);
  }
  for (const p of all) for (const s of seats) {
    const sb = seatHitBox([s.x, s.y, s.z]);
    if ([...p.closed, ...p.open].some(x => hitBoxesOverlap(x, sb))) audit.seatOverlaps.push(`${p.a.label} x ${s.label}`);
  }
  return audit;
}
