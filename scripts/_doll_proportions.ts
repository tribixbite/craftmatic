/**
 * Are the mini-doll rig's joints the LDraw library's? Every whole-doll and
 * hips-and-legs COMPOSITE in the upstream library (`92198p01c01` .. a doll put
 * together by LDraw's own authors, `16925` / `2277` a hips with its legs) is
 * flattened one level, each sub-part classified into its doll slot, and its
 * offset from the torso (or, for a hips-and-legs composite, from the hips)
 * compared with `MINIDOLL_CANON`. It is the measurement behind "the doll's
 * proportions match the rig": the canon was taken from the library's torso
 * composites (`92456`), and this checks it against the whole dolls and every
 * hinge generation (thick `92248`, thin `1015152`) it has to hold.
 *
 * Usage: bun scripts/_doll_proportions.ts [--json=<out>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { classifyMiniDollPart, MINIDOLL_CANON, type MiniDollSlot } from '../web/src/engine/minifig-rig.ts';

const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;
const provider = createPartGeometryProvider();
const DIRS = [`${CLEGO}/ldraw_ref/official/parts`, `${CLEGO}/ldraw_ref/unofficial/parts`];

type V3 = [number, number, number];
interface Sub { name: string; slot: MiniDollSlot | null; at: V3 }
const descCache = new Map<string, string>();
async function desc(name: string): Promise<string> {
  if (!descCache.has(name)) descCache.set(name, (await provider.getPartMesh(name))?.description ?? '');
  return descCache.get(name)!;
}

/** Slot -> canon offset from the torso (the doll's own frame). */
const CANON: Partial<Record<MiniDollSlot, V3>> = {
  doll_head: MINIDOLL_CANON.head!.position as V3,
  doll_hips: MINIDOLL_CANON.hips!.position as V3,
  doll_leg: MINIDOLL_CANON.legs!.position as V3,
  doll_hips_legs: MINIDOLL_CANON.hips_legs!.position as V3,
};

const rows: Array<Record<string, unknown>> = [];
const err = new Map<string, number[]>();
for (const dir of DIRS) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter(n => n.endsWith('.dat'))) {
    const text = readFileSync(`${dir}/${file}`, 'utf8');
    const lines = text.split(/\r?\n/).filter(l => l.startsWith('1 '));
    if (lines.length < 2 || lines.length > 12) continue;
    const subs: Sub[] = [];
    for (const l of lines) {
      const t = l.trim().split(/\s+/);
      const name = t.slice(14).join(' ');
      if (/[\\/]/.test(name)) continue;
      subs.push({ name, slot: classifyMiniDollPart(name, await desc(name)), at: [Number(t[2]), Number(t[3]), Number(t[4])] });
    }
    const torso = subs.find(s => s.slot === 'doll_torso');
    const hips = subs.find(s => s.slot === 'doll_hips');
    const legs = subs.find(s => s.slot === 'doll_leg');
    const head = subs.find(s => s.slot === 'doll_head');
    const arms = subs.filter(s => s.slot === 'doll_arm');
    if (torso && (head || hips || legs)) {
      // A whole doll: every slot relative to its torso.
      const rel = (s: Sub): V3 => [s.at[0] - torso.at[0], s.at[1] - torso.at[1], s.at[2] - torso.at[2]];
      const row: Record<string, unknown> = { file, kind: 'doll' };
      for (const s of [head, hips, legs].filter((x): x is Sub => !!x)) {
        const r = rel(s), c = CANON[s.slot!]!;
        const d = Math.hypot(r[0] - c[0], r[1] - c[1], r[2] - c[2]);
        row[s.slot!] = { at: r.map(v => +v.toFixed(2)), off: +d.toFixed(2) };
        err.set(`doll:${s.slot}`, [...(err.get(`doll:${s.slot}`) ?? []), d]);
      }
      for (const a of arms) {
        const r = rel(a);
        const d = Math.hypot(Math.abs(r[0]) - 11, r[1], r[2]);
        err.set('doll:doll_arm', [...(err.get('doll:doll_arm') ?? []), d]);
      }
      rows.push(row);
    } else if (!torso && hips && legs && subs.length === 2) {
      // A hips-and-legs composite: the legs relative to the hips, against the canon's legs - hips.
      const r: V3 = [legs.at[0] - hips.at[0], legs.at[1] - hips.at[1], legs.at[2] - hips.at[2]];
      const c = MINIDOLL_CANON.legs!.position, h = MINIDOLL_CANON.hips!.position;
      const want: V3 = [c[0] - h[0], c[1] - h[1], c[2] - h[2]];
      const d = Math.hypot(r[0] - want[0], r[1] - want[1], r[2] - want[2]);
      const hinge = /Thin Hinge/i.test(await desc(hips.name)) ? 'thin' : 'thick';
      rows.push({ file, kind: `hips+legs (${hinge})`, legsFromHips: r.map(v => +v.toFixed(2)), want: want.map(v => +v.toFixed(2)), off: +d.toFixed(2) });
      err.set(`legs-from-hips:${hinge}`, [...(err.get(`legs-from-hips:${hinge}`) ?? []), d]);
    }
  }
}
const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? NaN; };
const summary = Object.fromEntries([...err].map(([k, v]) => [k, { n: v.length, median: +med(v).toFixed(2), max: +Math.max(...v).toFixed(2) }]));
console.log(JSON.stringify(summary, null, 1));
const json = process.argv.find(a => a.startsWith('--json='))?.slice(7);
if (json) writeFileSync(json, JSON.stringify({ summary, rows }, null, 1));
