#!/usr/bin/env bun
/**
 * Measure the mini-doll skeleton the `.lxf` loader produces, before and after
 * the slot correction — the A/B that says whether `MINIDOLL_SLOT_CORRECTION`
 * actually fixes the joints it claims to.
 *
 * It runs the SHIPPED placement code (`buildLxfPlacements` with the tables from
 * `web/public/`), once with `miniDoll: false` and once with the default, and
 * reports the median distance between each pair of joints against the authentic
 * mini-doll values measured from the 6 OMR Friends packages:
 *
 *     torso → head  33.20     torso → arm   11.00
 *     torso → hips  29.42     hips  → legs  47.48
 *
 * Partners are matched NEAREST-FIRST, exactly as clego's `part_family`
 * figure_report does, so a file with more hips than legs (an inventory fact —
 * 41732 ships 7 hips and 4 legs) pairs a leftover hips with another figure's
 * legs and reads far too high in BOTH columns. That is why every per-file
 * regression is printed with its `n`: a median over 2 mismatched pairs is not
 * evidence about the correction.
 *
 * Usage:
 *   bun scripts/minidoll-joint-eval.ts --dir C:/git/clego/lego_sets/DBIX_LXFML
 *   bun scripts/minidoll-joint-eval.ts --dir C:/git/clego/lego_sets/LXF --json out.json
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import {
  buildLxfPlacements, miniDollSlotOf, validatePartAlign, validateMeasuredAlign, validateTable,
  type LxfPartRecord, type LxfAlignmentTable, type LxfMeasuredTable,
} from '../web/src/engine/lxf-parser.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { MiniDollSlot } from '../web/src/engine/minifig-rig.js';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DIR = resolve(flag('dir') ?? 'C:/git/clego/lego_sets/DBIX_LXFML');
const LIMIT = Number(flag('limit') ?? Infinity);
const JSON_OUT = flag('json');
/**
 * Write each doll-bearing file's placements as `<stem>-before.ldr` and
 * `<stem>-after.ldr` — the loader's OWN output, so the real app can render the
 * A/B without the source tree being switched underneath it.
 */
const DUMP_LDR = flag('dump-ldr');
const NL = String.fromCharCode(10);

/** The authentic joint distances (LDU), clego DBIX_SOLVER.md §11. */
const AUTHENTIC: Record<string, number> = {
  'torso->head': 33.20,
  'torso->arm': 11.00,
  'torso->hips': 29.42,
  'hips->leg': 47.48,
};

// ── the two shipped tables, straight off disk ────────────────────────────────
const table = validateTable(
  JSON.parse(readFileSync('web/public/ldd-part-map.json', 'utf8')),
  'web/public/ldd-part-map.json', validatePartAlign,
) as LxfAlignmentTable;
const measured = validateTable(
  JSON.parse(readFileSync('web/public/ldd-measured-align.json', 'utf8')),
  'web/public/ldd-measured-align.json', validateMeasuredAlign,
) as LxfMeasuredTable;

// ── LXFML → the parser's own record shape ────────────────────────────────────
/** The single LXFML entry of a `.lxf` ZIP (stored or deflated), or the file itself. */
function lxfmlBytes(path: string): Buffer {
  const buf = readFileSync(path);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return buf; // bare .lxfml
  // Minimal local-header walk: enough for LDD's own archives, which store one
  // LXFML plus a thumbnail. (The engine uses `zip-utils`; this is a script.)
  for (let i = 0; i + 30 <= buf.length;) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compressed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('latin1');
    const start = i + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compressed);
    if (/\.lxfml$/i.test(name)) {
      if (method === 0) return Buffer.from(body);
      if (method === 8) return inflateRawSync(body);
      return gunzipSync(body);
    }
    i = start + compressed;
  }
  throw new Error(`${basename(path)}: no LXFML entry`);
}

const PART_RE = /<Part\b([^>]*)>([\s\S]*?)<\/Part>|<Part\b([^>]*)\/>/g;
const BRICK_RE = /<Brick\b([^>]*)>([\s\S]*?)<\/Brick>/g;
const BONE_RE = /<Bone\b([^>]*?)\/?>/g;
const attr = (text: string, name: string): string | undefined =>
  new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(text)?.[1];

function readRecords(path: string): LxfPartRecord[] {
  const xml = lxfmlBytes(path).toString('utf8');
  const out: LxfPartRecord[] = [];
  for (const brick of xml.matchAll(BRICK_RE)) {
    const brickDesign = attr(brick[1] ?? '', 'designID');
    const inner = brick[2] ?? '';
    for (const part of inner.matchAll(PART_RE)) {
      const head = part[1] ?? part[3] ?? '';
      const body = part[2] ?? '';
      const bones = [...body.matchAll(BONE_RE)];
      out.push({
        designID: (attr(head, 'designID') ?? brickDesign ?? '3001').split(';')[0]!.trim(),
        materialId: parseInt((attr(head, 'materials') ?? '').split(',')[0]!, 10) || 194,
        transformation: attr(bones[0]?.[1] ?? '', 'transformation') ?? '',
        boneCount: bones.length,
      });
    }
  }
  return out;
}

// ── joints ───────────────────────────────────────────────────────────────────
const dist = (a: ParsedBrick, b: ParsedBrick): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const median = (v: number[]): number => {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Every joint distance in one model, by joint name. */
function joints(bricks: ParsedBrick[]): Record<string, number[]> {
  const by = new Map<MiniDollSlot, ParsedBrick[]>();
  for (const b of bricks) {
    const slot = miniDollSlotOf(b.part);
    if (!slot) continue;
    const list = by.get(slot) ?? [];
    list.push(b);
    by.set(slot, list);
  }
  const out: Record<string, number[]> = {};
  const pair = (name: string, from: MiniDollSlot, to: MiniDollSlot, each = 1): void => {
    const a = by.get(from) ?? [], b = by.get(to) ?? [];
    if (!a.length || !b.length) return;
    const v: number[] = [];
    for (const x of a) {
      const sorted = [...b].sort((p, q) => dist(x, p) - dist(x, q));
      for (const y of sorted.slice(0, each)) v.push(dist(x, y));
    }
    out[name] = v;
  };
  pair('torso->head', 'doll_torso', 'doll_head');
  pair('torso->arm', 'doll_torso', 'doll_arm', 2);
  pair('torso->hips', 'doll_torso', 'doll_hips');
  pair('hips->leg', 'doll_hips', 'doll_leg');
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────
if (!existsSync(DIR)) throw new Error(`no such directory: ${DIR}`);
const files = readdirSync(DIR).filter(f => /\.lxfm?l?$/i.test(f)).sort().slice(0, LIMIT);
console.log(`[minidoll-joint-eval] ${files.length} files in ${DIR}`);

const pooled: Record<string, { before: number[]; after: number[] }> = {};
const perFile: Array<{ file: string; joint: string; before: number; after: number; n: number }> = [];
let filesWithDolls = 0, dollPlacements = 0, deferred = 0;
const dollFiles: string[] = [];

for (const name of files) {
  let records: LxfPartRecord[];
  try {
    records = readRecords(join(DIR, name));
  } catch (err) {
    console.warn(`  ${name}: ${(err as Error).message}`);
    continue;
  }
  // Cheap gate first: 2 GB of LXFML, and only a few hundred files hold a doll.
  // Building placements twice for the rest was most of the run's cost.
  // The gate must resolve the FILENAME the same way the loader does — design
  // `21630` is `92250.dat`, a doll leg, and the raw id names no doll mould.
  const isDoll = (r: LxfPartRecord): boolean => miniDollSlotOf(
    table.entries[r.designID]?.[0] ?? measured.entries[r.designID]?.[0] ?? `${r.designID}.dat`,
  ) !== null;
  if (!records.some(isDoll)) continue;
  const before = buildLxfPlacements(records, table, measured, { miniDoll: false });
  const after = buildLxfPlacements(records, table, measured);
  if (after.diagnostics.miniDollPlacements === 0 && after.diagnostics.miniDollDeferredToTable === 0) continue;
  filesWithDolls++;
  dollFiles.push(name);
  dollPlacements += after.diagnostics.miniDollPlacements;
  deferred += after.diagnostics.miniDollDeferredToTable;
  if (DUMP_LDR) {
    mkdirSync(DUMP_LDR, { recursive: true });
    const stem = name.replace(/\.[^.]+$/, '');
    for (const [suffix, built] of [['before', before], ['after', after]] as const) {
      const lines = [`0 ${stem} ${suffix} (mini-doll correction ${suffix === 'after' ? 'on' : 'off'})`, '0 Name: ' + stem];
      for (const b of built.bricks) {
        const r = (b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).map(v => v.toFixed(6)).join(' ');
        lines.push(`1 ${b.color} ${b.x.toFixed(4)} ${b.y.toFixed(4)} ${b.z.toFixed(4)} ${r} ${b.part}`);
      }
      writeFileSync(join(DUMP_LDR, `${stem}-${suffix}.ldr`), lines.join(NL) + NL);
    }
  }
  const jb = joints(before.bricks), ja = joints(after.bricks);
  for (const joint of Object.keys(AUTHENTIC)) {
    const b = jb[joint] ?? [], a = ja[joint] ?? [];
    if (!b.length || !a.length) continue;
    (pooled[joint] ??= { before: [], after: [] }).before.push(...b);
    pooled[joint]!.after.push(...a);
    const mb = median(b), ma = median(a);
    if (Math.abs(mb - ma) > 1e-6) perFile.push({ file: name, joint, before: mb, after: ma, n: a.length });
  }
}

console.log(`\nfiles with mini-doll parts: ${filesWithDolls} / ${files.length}`);
console.log(`mini-doll placements corrected: ${dollPlacements}; deferred to a table row: ${deferred}\n`);
console.log('joint         authentic   before     after      n     |err| before → after');
for (const [joint, want] of Object.entries(AUTHENTIC)) {
  const p = pooled[joint];
  if (!p) { console.log(`${joint.padEnd(13)} ${want.toFixed(2).padStart(8)}   (no pairs)`); continue; }
  const mb = median(p.before), ma = median(p.after);
  const eb = median(p.before.map(v => Math.abs(v - want)));
  const ea = median(p.after.map(v => Math.abs(v - want)));
  console.log(
    `${joint.padEnd(13)} ${want.toFixed(2).padStart(8)} ${mb.toFixed(2).padStart(9)} ${ma.toFixed(2).padStart(9)}` +
    ` ${String(p.after.length).padStart(6)}     ${eb.toFixed(2)} → ${ea.toFixed(2)}`,
  );
}

const worse = perFile.filter(r => Math.abs(r.after - AUTHENTIC[r.joint]!) > Math.abs(r.before - AUTHENTIC[r.joint]!) + 1e-6);
console.log(`\nper-file joint medians that changed: ${perFile.length}; WORSE: ${worse.length}`);
for (const r of worse.sort((a, b) => Math.abs(b.after - AUTHENTIC[b.joint]!) - Math.abs(a.after - AUTHENTIC[a.joint]!))) {
  console.log(`  ${r.file.padEnd(34)} ${r.joint.padEnd(12)} ${r.before.toFixed(2).padStart(8)} → ${r.after.toFixed(2).padStart(8)}  n=${r.n}`);
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    dir: DIR, files: files.length, filesWithDolls, dollPlacements, deferred, dollFiles,
    pooled: Object.fromEntries(Object.entries(pooled).map(([k, v]) => [k, {
      authentic: AUTHENTIC[k], before: median(v.before), after: median(v.after), n: v.after.length,
    }])),
    perFile, worse,
  }, null, 1));
  console.log(`\nwrote ${JSON_OUT}`);
}
