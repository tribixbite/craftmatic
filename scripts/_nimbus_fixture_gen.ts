/**
 * Writes `test/fixtures/nimbus-fixture.ldr`: the stand-in for LEGO 11390
 * (Dragon Ball: Shenron & Goku, released 2026-11-01) until its model file
 * exists. A real LDraw model of real library parts and colours, in the shape a
 * DBIX final-model page would give: a tall rock-and-dragon stack on a black
 * base, and beside it a minifig standing on a small golden cloud (yellow /
 * bright light orange / white slopes and plates) joined to the rock by one
 * trans-clear bar - the shape `findMounts` (engine/bedrock-flyer.ts) must read
 * as a canon `cloud` mount with its figure.
 *
 *   bun scripts/_nimbus_fixture_gen.ts
 *
 * LDU, LDraw Y down: a part's origin is the centre of its TOP (stud) plane and
 * its body extends to +Y, 24 for a brick, 8 for a plate (its studs sit at
 * -4..0). So a brick standing on a surface at y = s has its origin at s - 24.
 * The figure follows the canonical minifig offsets of engine/minifig-rig.ts
 * (`MINIFIG_CANON`, feet 72 under the torso).
 */
import { writeFileSync } from 'node:fs';

const OUT = 'test/fixtures/nimbus-fixture.ldr';
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Rotation about +Y by `deg` (row-major, LDraw). */
const ry = (deg: number): number[] => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return [c, 0, s, 0, 1, 0, -s, 0, c].map(v => Math.abs(v) < 1e-9 ? 0 : v); };
/** Local Y to world -X (a bar authored along -Y laid flat along +X). */
const Y_TO_X = [0, 1, 0, -1, 0, 0, 0, 0, 1];
const f = (v: number): string => { const r = Math.round(v * 1000) / 1000; return String(r === 0 ? 0 : r); };
const lines: string[] = [
  '0 Nimbus fixture: a rock-and-dragon pillar on a black base, a minifig on a golden cloud beside it',
  '0 Name: nimbus-fixture.ldr',
  '0 Author: craftmatic (scripts/_nimbus_fixture_gen.ts)',
  '0 !LDRAW_ORG Unofficial_Model',
  '0 // Stand-in for 11390 until its model file exists: the cloud is a canon flyer mount (engine/set-canon.ts).',
];
const place = (colour: number, x: number, y: number, z: number, rot: readonly number[], part: string): void => {
  lines.push(`1 ${colour} ${f(x)} ${f(y)} ${f(z)} ${rot.map(f).join(' ')} ${part}.dat`);
};

// ── The base: four black 6 x 6 plates, 12 x 12 studs, underside at y = 0 (body -8..0) ──
for (const x of [-60, 60]) for (const z of [-60, 60]) place(0, x, -8, z, I, '3958');

// ── The rock pillar: 22 layers of 2 x 2 bricks, a green dragon coil, slopes ──
const DARK_BLUISH_GREY = 72, DARK_GREY = 8, DARK_GREEN = 288, GREEN = 2;
/** The origin of a brick in layer `k`: its bottom on the base's top (-8) or the layer below, 24 up per layer. */
const layerY = (k: number): number => -32 - 24 * k;
const grid3 = [-40, 0, 40];
/** The 3 x 3 footprint's perimeter cells, clockwise from the north-west, for the dragon coil. */
const ring: Array<[number, number]> = [[-40, -40], [0, -40], [40, -40], [40, 0], [40, 40], [0, 40], [-40, 40], [-40, 0]];
for (let k = 0; k < 16; k++) {
  const coil = new Set<string>();
  if (k >= 6) { const a = (k * 2) % 8, b = (k * 2 + 1) % 8; coil.add(ring[a]!.join(',')); coil.add(ring[b]!.join(',')); }
  for (const x of grid3) for (const z of grid3) {
    const colour = coil.has(`${x},${z}`) ? DARK_GREEN : (x + z + k * 40) % 80 === 0 ? DARK_BLUISH_GREY : DARK_GREY;
    place(colour, x, layerY(k), z, I, '3003');
  }
  // The dragon's flank: a green slope hanging off the coil's outer face.
  if (k >= 6) {
    const [cx, cz] = ring[(k * 2) % 8]!;
    const out = [cx === 0 ? 0 : Math.sign(cx), cz === 0 ? 0 : Math.sign(cz)];
    const yaw = out[0] === 1 ? 90 : out[0] === -1 ? 270 : out[1] === 1 ? 0 : 180;
    place(k % 2 ? DARK_GREEN : GREEN, cx + out[0]! * 40, layerY(k), cz + out[1]! * 40, ry(yaw), '3039');
  }
  // Rock texture: a 45-degree slope on every side every third layer.
  if (k % 3 === 1) {
    place(DARK_GREY, 80, layerY(k), 0, ry(90), '3039');
    place(DARK_GREY, -80, layerY(k), 0, ry(270), '3039');
    place(DARK_BLUISH_GREY, 0, layerY(k), 80, ry(0), '3039');
    place(DARK_BLUISH_GREY, 0, layerY(k), -80, ry(180), '3039');
  }
}
// A skirt of 1 x 2 bricks round the foot of the rock, four layers.
for (let k = 0; k < 4; k++) {
  for (const z of [-40, 0, 40]) { place(DARK_GREY, 70, layerY(k), z, ry(90), '3004'); place(DARK_BLUISH_GREY, -70, layerY(k), z, ry(90), '3004'); }
  for (const x of [-40, 0, 40]) { place(DARK_BLUISH_GREY, x, layerY(k), 70, I, '3004'); place(DARK_GREY, x, layerY(k), -70, I, '3004'); }
}
// The narrowing top: a cross of five bricks for six layers, then a peak of slopes.
for (let k = 16; k < 22; k++) {
  place(DARK_BLUISH_GREY, 0, layerY(k), 0, I, '3003');
  for (const [x, z] of [[-40, 0], [40, 0], [0, -40], [0, 40]] as const) place(k % 2 ? DARK_GREY : DARK_BLUISH_GREY, x, layerY(k), z, I, '3003');
}
const peak = layerY(22);
place(DARK_GREY, 40, peak, 0, ry(90), '3039'); place(DARK_GREY, -40, peak, 0, ry(270), '3039');
place(DARK_BLUISH_GREY, 0, peak, 40, ry(0), '3039'); place(DARK_BLUISH_GREY, 0, peak, -40, ry(180), '3039');
place(DARK_GREEN, 0, peak, 0, I, '3003');

// ── The cloud: 26 parts of yellow, bright light orange and white, centre x = 180 ──
// Library extents (studs excluded): 3032 "Plate 4 x 6" is x +-60, z +-40; 3021
// "Plate 2 x 3" x +-30, z +-20; 3020 "Plate 2 x 4" x +-40, z +-20; 3024 a 1 x 1
// plate; 54200 "Slope Brick 31 1 x 1 x 0.667" has its ORIGIN AT THE BOTTOM
// (body -15.6..0), the one part here that does.
const YELLOW = 14, BRIGHT_LIGHT_ORANGE = 191, WHITE = 15, TRANS_CLEAR = 47;
/** The cloud's bottom plate: origin (top) at -200, body -200..-192, x 120..240, z -40..40. */
const CX = 180, CLOUD_TOP0 = -200;
place(BRIGHT_LIGHT_ORANGE, CX, CLOUD_TOP0, 0, I, '3032');
for (const dx of [-30, 30]) for (const dz of [-20, 20]) place(YELLOW, CX + dx, CLOUD_TOP0 - 8, dz, I, '3021'); // four 2 x 3 plates tiling it (top -208)
// A ring of 1 x 1 x 2/3 slopes standing on the 16 perimeter studs of that layer (studs at odd multiples of 10), sloping outward.
const LAYER2_TOP = CLOUD_TOP0 - 8;
let n = 0;
for (let ix = -50; ix <= 50; ix += 20) for (let iz = -30; iz <= 30; iz += 20) {
  if (Math.abs(ix) !== 50 && Math.abs(iz) !== 30) continue;
  const yaw = Math.abs(ix) === 50 ? (ix > 0 ? 90 : 270) : (iz > 0 ? 0 : 180);
  place(n++ % 3 === 2 ? WHITE : YELLOW, CX + ix, LAYER2_TOP, iz, ry(yaw), '54200');
}
const FLOOR_PLATE = LAYER2_TOP - 8;                                         // Plate 2 x 4 inside the ring: the figure's floor, top at -216
place(WHITE, CX, FLOOR_PLATE, 0, I, '3020');
for (const dx of [-30, 30]) for (const dz of [-10, 10]) place(WHITE, CX + dx, FLOOR_PLATE - 8, dz, I, '3024'); // four 1 x 1 plates on its corners, clear of the feet
// The trans-clear bar (authored along +Y, laid along +X) joining the rock's flank (x = 60) to the cloud (x = 140), in the bottom plate's band.
place(TRANS_CLEAR, 60, CLOUD_TOP0 + 4, 0, Y_TO_X, '30374');

// ── The figure: a minifig standing on the cloud's middle plate, facing -Z ──
const FEET = FLOOR_PLATE;           // the 2 x 4 plate's top
const T = FEET - 72;                // torso origin (MINIFIG_FEET_Y)
const C10 = Math.cos(10 * Math.PI / 180), S10 = Math.sin(10 * Math.PI / 180), C45 = Math.SQRT1_2;
const ARM_R = [C10, -S10, 0, S10, C10, 0, 0, 0, 1], ARM_L = [C10, S10, 0, -S10, C10, 0, 0, 0, 1];
const mul = (a: number[], b: number[]): number[] => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));
const TILT = [1, 0, 0, 0, C45, -C45, 0, C45, C45];
const ORANGE = 25, BLUE = 1, BLACK = 0;
place(ORANGE, CX, T, 0, I, '973');            // torso
place(YELLOW, CX, T - 24, 0, I, '3626c');     // head
place(BLACK, CX, T - 48, 0, I, '3901');       // hair
place(BLUE, CX, T + 32, 0, I, '3815');        // hips
place(ORANGE, CX, T + 44, 0, I, '3816');      // leg right
place(ORANGE, CX, T + 44, 0, I, '3817');      // leg left
place(ORANGE, CX - 15.552, T + 9, 0, ARM_R, '3818');
place(ORANGE, CX + 15.552, T + 9, 0, ARM_L, '3819');
place(YELLOW, CX - 23.86, T + 26.6, -10.32, mul(ARM_R, TILT), '3820');
place(YELLOW, CX + 23.86, T + 26.6, -10.32, mul(ARM_L, TILT), '3820');

writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`${OUT}: ${lines.filter(l => l.startsWith('1 ')).length} placements`);
