/**
 * Writes the funfair test fixtures (BIZ-20, package RIDE):
 *
 *   test/fixtures/funfair/drop-tower.ldr   a 100-block drop tower: a mast of 17 stacked 2 x 2 x 13 supports on a
 *                                          base of 6 x 6 plates, and a ring of eight minifig seats carried on
 *                                          radial plate arms round it, hanging a brick over the base
 *   test/fixtures/funfair/sky-swing.ldr    a 60-block sky swing: the same kind of mast, and a canopy of four plate
 *                                          arms carrying four hanging swing seats (67075)
 *
 *   bun scripts/_funfair_fixture_gen.ts
 *
 * Both are ORIGINAL simple designs from generic official parts (supports 91176, plates 3958 / 3034, the minifig
 * seat 4079, the swing 67075), test fixtures and not a product: the polished paid versions live in the private
 * designs repo. The mast has no collar through the ring (the ring simply hangs beside it).
 *
 * LDU, LDraw Y down: a part's origin is its TOP plane and its body runs to +Y (a plate is [y, y + 8], a 2 x 2 x 13
 * support [y, y + 312]); the seat's body is [y - 40, y + 8] and the swing's [y - 111, y + 16]. Measured with
 * `bun scripts/_funfair_part_bounds.ts <part>...`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT_DIR = 'test/fixtures/funfair';
const f = (v: number): string => { const r = Math.round(v * 1000) / 1000; return String(r === 0 ? 0 : r); };
/** Rotation about +Y by `deg` (row-major, LDraw). */
const ry = (deg: number): number[] => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A part's support, a plate's body height and the supports' (312) and a stud-free brick height, LDU. */
const PLATE = 8, SUPPORT = 312;
const DARK_BLUISH_GREY = 72, LIGHT_BLUISH_GREY = 71, RED = 4, BLUE = 1, YELLOW = 14;

class Model {
  readonly lines: string[];
  constructor(title: string, name: string) {
    this.lines = [`0 ${title}`, `0 Name: ${name}`, '0 Author: craftmatic (scripts/_funfair_fixture_gen.ts)', '0 !LDRAW_ORG Unofficial_Model', '0 // BIZ-20 test fixture: simple original design from generic official parts.'];
  }
  place(colour: number, x: number, y: number, z: number, rot: readonly number[], part: string): void {
    this.lines.push(`1 ${colour} ${f(x)} ${f(y)} ${f(z)} ${rot.map(f).join(' ')} ${part}.dat`);
  }
  write(file: string): void { writeFileSync(`${OUT_DIR}/${file}`, `${this.lines.join('\n')}\n`); }
}

/** The base: a `n` x `n` grid of 6 x 6 plates centred on the axis, underside at y 0 (body -8..0). Its top is y -8. */
function base(m: Model, n: number): void {
  const half = (n - 1) / 2;
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) m.place(DARK_BLUISH_GREY, (i - half) * 120, -PLATE, (k - half) * 120, I, '3958');
}

/** The mast: `count` supports stacked on the base's top (-8), a cap plate on the top. Returns the mast's top y. */
function mast(m: Model, count: number): number {
  for (let k = 0; k < count; k++) m.place(k % 2 ? LIGHT_BLUISH_GREY : DARK_BLUISH_GREY, 0, -PLATE - SUPPORT * (k + 1), 0, I, '91176');
  const top = -PLATE - SUPPORT * count;
  m.place(YELLOW, 0, top - PLATE, 0, I, '3958');
  return top;
}

/** The yaw whose rotation maps a part's local -Z (a seat's front) and local +X to the outward and tangent directions at azimuth `deg`. */
const outwardYaw = (deg: number): number => Math.atan2(-Math.sin(deg * Math.PI / 180), -Math.cos(deg * Math.PI / 180)) * 180 / Math.PI;

mkdirSync(OUT_DIR, { recursive: true });

// ── The drop tower: 17 supports = 5,304 LDU = 99.5 blocks of mast ──
{
  const m = new Model('Drop tower fixture: a 100-block mast with a ring of eight seats', 'drop-tower.ldr');
  base(m, 6);
  mast(m, 17);
  // The ring hangs one brick (24 LDU) over the base: its plates' underside is y -32 (so nothing of the base is in the car).
  const ringPlate = -PLATE - 24 - PLATE; // plate origin: body -40..-32
  const SEATS = 8, RADIUS = 160;
  for (let i = 0; i < SEATS; i++) {
    const a = i / SEATS * 360, x = Math.cos(a * Math.PI / 180) * RADIUS, z = Math.sin(a * Math.PI / 180) * RADIUS;
    // A 2 x 8 arm from the mast (radius 40) out past the seat (200), its length (local x) along the radius, then the plate under the seat.
    m.place(RED, Math.cos(a * Math.PI / 180) * 120, ringPlate, Math.sin(a * Math.PI / 180) * 120, ry(-a), '3034');
    m.place(BLUE, x, ringPlate, z, ry(-a), '3958');
    // The seat stands on the plate (foot y + 8 = plate top), its front (-Z) outward.
    m.place(YELLOW, x, ringPlate - 8, z, ry(outwardYaw(a)), '4079');
  }
  m.write('drop-tower.ldr');
}

// ── The sky swing: 10 supports = 3,120 LDU = 58.5 blocks of mast ──
{
  const m = new Model('Sky swing fixture: a 60-block mast with a canopy of four hanging swings', 'sky-swing.ldr');
  base(m, 6);
  mast(m, 10);
  const SEATS = 4, RADIUS = 160;
  // The swings hang a brick and a bit over the base: the lowest part (the seat, body to y + 16) ends at -32.
  const swingY = -PLATE - 24 - 16, canopy = swingY - 119; // the swing's top bar is y - 111; the canopy plate (body canopy..canopy + 8) sits on it
  for (let i = 0; i < SEATS; i++) {
    const a = i / SEATS * 360, x = Math.cos(a * Math.PI / 180) * RADIUS, z = Math.sin(a * Math.PI / 180) * RADIUS;
    m.place(RED, Math.cos(a * Math.PI / 180) * 120, canopy, Math.sin(a * Math.PI / 180) * 120, ry(-a), '3034');
    m.place(BLUE, x, canopy, z, ry(-a), '3958');
    m.place(YELLOW, x, swingY, z, ry(outwardYaw(a)), '67075');
  }
  m.write('sky-swing.ldr');
}
