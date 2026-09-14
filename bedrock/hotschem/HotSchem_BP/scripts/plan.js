import { sizeOf } from './placement-geometry.js';
export const SCALES = [.25, .5, 1, 2];
export function restorePlan(raw, models) {
  const s = { key: null, rotation: 0, scale: 1, mode: 0, anchor: null, preview: false, step: 1 };
  if (!raw || typeof raw !== 'object') return s;
  if (models[raw.key]) s.key = raw.key;
  if ([0, 90, 180, 270].includes(raw.rotation)) s.rotation = raw.rotation;
  if (SCALES.includes(raw.scale)) s.scale = raw.scale;
  if (raw.mode === 1) s.mode = 1;
  if (raw.anchor && validCoordinates(raw.anchor) && typeof raw.dimension === 'string') { s.anchor = { ...raw.anchor }; s.dimension = raw.dimension; }
  s.preview = raw.preview === true;
  if (raw.step === 10) s.step = 10;
  return s;
}
export function validCoordinates(a) { return ['x', 'y', 'z'].every(k => Number.isSafeInteger(a[k]) && Math.abs(a[k]) < 30000000); }
export function selectModel(s, key) { s.key = key; } // Position, rotation and size are independent of selection.
export function setScale(s, scale) { if (!SCALES.includes(scale)) throw new Error('Choose 25%, 50%, 100% or 200%.'); s.scale = scale; }
export function setOrigin(s, anchor, dimension) { if (!validCoordinates(anchor)) throw new Error('Enter whole-number X, Y and Z coordinates.'); s.anchor = { ...anchor }; s.dimension = dimension; s.preview = true; }
export function planBounds(s, models) { const size = sizeOf(models[s.key], s.rotation, s.scale); return { from: { ...s.anchor }, to: { x: s.anchor.x + size.x - 1, y: s.anchor.y + size.y - 1, z: s.anchor.z + size.z - 1 } }; }
export const dimensions = size => `${size.x} × ${size.y} × ${size.z}`;

// Dense nearby edges stay legible even when the far side of a large build is unloaded.
export function previewPoints(b, viewer, radius = 56) {
  const points = [], add = p => { if (['x', 'y', 'z'].every(a => Math.abs(p[a] - viewer[a]) <= radius)) points.push(p); };
  for (const axis of ['x', 'y', 'z']) {
    const others = ['x', 'y', 'z'].filter(a => a !== axis);
    for (let mask = 0; mask < 4; mask++) {
      const p = { ...b.from };
      others.forEach((a, j) => { p[a] = mask & (1 << j) ? b.to[a] + 1 : b.from[a]; });
      const start = Math.max(b.from[axis], Math.ceil(viewer[axis] - radius));
      const end = Math.min(b.to[axis] + 1, viewer[axis] + radius);
      for (let n = start; n <= end; n += 1) add({ ...p, [axis]: n, y: (axis === 'y' ? n : p.y) + .12 });
    }
  }
  // A tall, unmistakable origin marker and short +X/+Z guide arms.
  for (let n = 0; n <= 6; n += .35) add({ x: b.from.x + .12, y: b.from.y + n + .15, z: b.from.z + .12 });
  for (let n = 0; n <= 5; n += .35) { add({ x: b.from.x + n, y: b.from.y + .2, z: b.from.z }); add({ x: b.from.x, y: b.from.y + .2, z: b.from.z + n }); }
  return points;
}
