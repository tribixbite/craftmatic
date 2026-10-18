#!/usr/bin/env bun
/**
 * Build-time script: classify every mini-doll (LEGO Friends) mould in the
 * LDraw library into its SLOT and emit
 * `web/src/engine/minidoll-slots-generated.ts`.
 *
 * WHY A GENERATED TABLE AND NOT A RUNTIME LOOKUP. The slot is decided by the
 * mould's LDraw DESCRIPTION (`classifyMiniDollPart`), and the `.lxf` loader has
 * no descriptions: it turns LDD design ids into LDraw filenames from two JSON
 * tables and the part text is fetched later, by the renderer. Making the parser
 * fetch every part's `.dat` before it can place anything would turn a
 * two-request parse into an N-request one. So the SAME description classifier
 * runs here, once, over the library, and only the slot is baked per mould — the
 * correction itself stays per-SLOT (six vectors, in `lxf-parser.ts`), which is
 * what covers the 13 LDD legs moulds and 5 torso moulds the reference library
 * has no composite for.
 *
 * `~Moved to <id>` stubs are followed (a stub has no description of its own),
 * which is what stops `92241p03c01` — a redirect to the torso-WITH-ARMS
 * composite `92456p03`, 12.8 LDU lower — from reading as a plain torso.
 *
 * Usage: bun scripts/gen-minidoll-slots.ts   (LDRAW_ROOTS="<root>|<sub>|<sub>;…" to override)
 * Re-run whenever the LDraw library is updated.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyMiniDollPart, movedTo, type MiniDollSlot } from '../web/src/engine/minifig-rig.js';

/**
 * Both libraries craftmatic has on disk, LOWEST priority first. Studio's
 * bundled tree is a five-year-old snapshot (it has no `2645.dat` at all, a
 * mini-doll hair the LXFML corpus places), so clego's `ldraw_ref` mirror is
 * read last and wins. Scanning both is strictly more coverage: a mould that is
 * in neither cannot render either, and a row for a mould no source places is
 * inert.
 */
const LIBRARIES = (process.env.LDRAW_ROOTS ?? [
  'C:/git/clego/extracted/studio_release/app/ldraw|parts|UnOfficial/parts',
  'C:/git/clego/ldraw_ref|official/parts|unofficial/parts',
].join(';')).split(';');
const PART_DIRS = LIBRARIES.flatMap(spec => {
  const [root, ...subs] = spec.split('|');
  return subs.map(sub => join(resolve(root!), ...sub.split('/')));
});
const OUT_FILE = resolve(import.meta.dir, '../web/src/engine/minidoll-slots-generated.ts');

/**
 * The LDraw description: the first line with its `0 ` stripped — except when
 * that line is an MPD `0 FILE <name>` header (Studio's `69969.dat`, a mini-doll
 * body, starts with one), where the description is the line after it.
 */
function descriptionOf(path: string): string {
  const text = readFileSync(path, 'latin1');
  for (const raw of text.split('\n', 4)) {
    const line = raw.replace(/\r$/, '').replace(/^0\s*/, '').trim();
    if (line === '' || /^FILE\s/i.test(line)) continue;
    return line;
  }
  return '';
}

/** Every `<stem> → description` the libraries hold; a later dir wins. */
function readLibrary(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of PART_DIRS) {
    if (!existsSync(dir)) {
      console.warn(`[gen-minidoll-slots] missing parts dir: ${dir}`);
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.dat')) continue;
      out.set(name.slice(0, -4).toLowerCase(), descriptionOf(join(dir, name)));
    }
  }
  return out;
}

function main(): void {
  const lib = readLibrary();
  console.log(`[gen-minidoll-slots] ${lib.size} parts from ${PART_DIRS.length} dirs`);

  /** Follow `~Moved to` to the description the mould actually carries. */
  const resolved = (stem: string): string => {
    let cur = stem;
    for (let i = 0; i < 4; i++) {
      const desc = lib.get(cur) ?? '';
      const next = movedTo(desc);
      if (next === null) return desc;
      cur = next;
    }
    return '';
  };

  const rows: Array<[string, MiniDollSlot]> = [];
  const counts = new Map<MiniDollSlot, number>();
  for (const stem of [...lib.keys()].sort()) {
    const slot = classifyMiniDollPart(stem, resolved(stem));
    if (slot === null) continue;
    rows.push([stem, slot]);
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  if (rows.length === 0) throw new Error('no mini-doll moulds found — are the library paths right?');

  const summary = [...counts.entries()].sort().map(([k, n]) => `${k} ${n}`).join(', ');
  const body = rows.map(([stem, slot]) => `  '${stem}': '${slot}',`).join('\n');
  const text = `// AUTO-GENERATED — do not edit manually. Run: bun scripts/gen-minidoll-slots.ts
// Generated: ${new Date().toISOString()}
// Source: ${PART_DIRS.join(', ')}
// Entries: ${rows.length} mini-doll moulds (${summary})
//
// The SLOT of each mini-doll mould, classified from its LDraw description by
// \`classifyMiniDollPart\` with \`~Moved to\` stubs followed. The per-slot origin
// correction the \`.lxf\` loader applies lives in \`lxf-parser.ts\`
// (\`MINIDOLL_SLOT_CORRECTION\`) — this file says only which slot a mould is in.
import type { MiniDollSlot } from './minifig-rig.js';

export const MINIDOLL_SLOTS: Readonly<Record<string, MiniDollSlot>> = {
${body}
};
`;
  writeFileSync(OUT_FILE, text);
  console.log(`[gen-minidoll-slots] wrote ${rows.length} moulds (${summary}) → ${OUT_FILE}`);
}

main();
