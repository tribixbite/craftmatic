/**
 * Class-B re-frame: 327 part names ship in BOTH LDraw libraries — Studio's
 * frozen copy (what clego fits and what LDD/Studio-authored models mean) and
 * upstream (what prod's R2 mirror serves and the viewer draws) — with
 * different geometry, and for 161 of them it is the SAME mould in a different
 * frame (`70681` is shifted 20 LDU; `10313` is turned 90° about Y). A
 * placement authored against Studio's copy therefore draws the upstream mesh
 * in the wrong place. clego measured the frame `Q, t` with
 * `studio_local = Q · upstream_local + t` (`class_b_census.py`) and rewrites
 * its generated LDraw corpus in place; this module is the same correction for
 * what the CLIENT converts from Studio-frame sources at load time — an `.lxf`
 * (LDD bones through `ldraw.xml`) and the `model.ldr` inside an `.io`
 * (Studio-authored). Exact by construction:
 *
 *   world = R · studio_local + pos = R · (Q · up + t) + pos = (R·Q) · up + (R·t + pos)
 *
 * so `pos' = pos + R·t` and `R' = R·Q`, with `R` the row-major 3×3 of the LDraw
 * line. Never applied to LDraw text that already carries clego's
 * `0 !CLASS_B_REFRAME` stamp, and never to authentic (upstream-authored) files —
 * the callers are the two Studio-frame conversions only.
 * docs/lego-sources-guide.md §7a.
 */
import { CLASS_B_REFRAME } from './class-b-reframe-generated.js';

/** The stamp clego writes into a file it has already re-framed. */
export const CLASS_B_STAMP = '0 !CLASS_B_REFRAME';

export interface ReframedPlacement {
  rot: number[];
  x: number;
  y: number;
  z: number;
}

/** Lower-cased stem of a part reference (`parts/70681.DAT` → `70681`). */
export const reframeStem = (part: string): string => {
  const base = part.replace(/\\/g, '/').split('/').pop() ?? part;
  return base.toLowerCase().replace(/\.dat$/, '');
};

/** True when the library ships this name in two frames and a `Q, t` is known. */
export const hasClassBReframe = (part: string): boolean => reframeStem(part) in CLASS_B_REFRAME;

/**
 * Re-frame one placement (`rot` row-major 9, position in LDU). Returns null when
 * the part needs none, so a caller can count what moved.
 */
export function reframeClassB(part: string, rot: readonly number[], x: number, y: number, z: number): ReframedPlacement | null {
  const row = CLASS_B_REFRAME[reframeStem(part)];
  if (!row) return null;
  const [q0, q1, q2, q3, q4, q5, q6, q7, q8, t0, t1, t2] = row as [number, number, number, number, number, number, number, number, number, number, number, number];
  const [a, b, c, d, e, f, g, h, i] = rot as [number, number, number, number, number, number, number, number, number];
  return {
    rot: [
      a * q0 + b * q3 + c * q6, a * q1 + b * q4 + c * q7, a * q2 + b * q5 + c * q8,
      d * q0 + e * q3 + f * q6, d * q1 + e * q4 + f * q7, d * q2 + e * q5 + f * q8,
      g * q0 + h * q3 + i * q6, g * q1 + h * q4 + i * q7, g * q2 + h * q5 + i * q8,
    ],
    x: x + a * t0 + b * t1 + c * t2,
    y: y + d * t0 + e * t1 + f * t2,
    z: z + g * t0 + h * t1 + i * t2,
  };
}

const PART_LINE = /^(\s*1\s+\S+\s+)(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)(\s*)$/;
const fmt = (v: number): string => { const r = Math.round(v * 1000) / 1000; return String(r === 0 ? 0 : r); };

/**
 * Re-frame every type-1 line of a Studio-frame LDraw text (an `.io`'s
 * `model.ldr`). Lines referencing submodels or parts outside the table are
 * untouched byte-for-byte; a text clego already stamped is returned as is.
 */
export function reframeLdrawText(text: string): { text: string; moved: number } {
  if (text.includes(CLASS_B_STAMP)) return { text, moved: 0 };
  let moved = 0;
  const out = text.split('\n').map(line => {
    if (!/^\s*1\s/.test(line)) return line;
    const m = PART_LINE.exec(line);
    if (!m) return line;
    const ref = m[14]!;
    if (!hasClassBReframe(ref)) return line;
    const nums = m.slice(2, 14).map(Number);
    if (nums.some(Number.isNaN)) return line;
    const r = reframeClassB(ref, nums.slice(3, 12), nums[0]!, nums[1]!, nums[2]!);
    if (!r) return line;
    moved++;
    return `${m[1]}${[r.x, r.y, r.z, ...r.rot].map(fmt).join(' ')} ${ref}${m[15]}`;
  });
  return { text: moved ? out.join('\n') : text, moved };
}
