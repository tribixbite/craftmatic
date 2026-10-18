export function sizeOf(m, rotation, scale) {
  return { x: Math.max(1, Math.ceil((rotation % 180 ? m.l : m.w) * scale)), y: Math.max(1, Math.ceil(m.h * scale)), z: Math.max(1, Math.ceil((rotation % 180 ? m.w : m.l) * scale)) };
}
export function rotate(x, z, m, r) {
  if (r === 90) return [m.l - 1 - z, x];
  if (r === 180) return [m.w - 1 - x, m.l - 1 - z];
  if (r === 270) return [z, m.w - 1 - x];
  return [x, z];
}
export function transform(op, m, r, scale, anchor) {
  const a = rotate(op[0], op[2], m, r), b = rotate(op[3], op[5], m, r);
  const lo = [Math.min(a[0], b[0]), op[1], Math.min(a[1], b[1])];
  const hi = [Math.max(a[0], b[0]), op[4], Math.max(a[1], b[1])];
  const from = {}, to = {};
  for (const [i, axis] of ['x', 'y', 'z'].entries()) {
    from[axis] = anchor[axis] + Math.floor(lo[i] * scale);
    to[axis] = Math.max(from[axis], anchor[axis] + Math.ceil((hi[i] + 1) * scale) - 1);
  }
  return { from, to, palette: op[6] };
}
// Split at world-aligned 32-block boundaries (at most 32,768 blocks per fill).
// Every fill, clear and backup is wholly inside one loaded region.
export function* split(box) {
  for (let x = box.from.x; x <= box.to.x;) {
    const xx = Math.min(box.to.x, (Math.floor(x / 32) + 1) * 32 - 1);
    for (let z = box.from.z; z <= box.to.z;) {
      const zz = Math.min(box.to.z, (Math.floor(z / 32) + 1) * 32 - 1);
      for (let y = box.from.y; y <= box.to.y;) {
        const yy = Math.min(box.to.y, (Math.floor(y / 32) + 1) * 32 - 1);
        yield { from: { x, y, z }, to: { x: xx, y: yy, z: zz }, palette: box.palette };
        y = yy + 1;
      }
      z = zz + 1;
    }
    x = xx + 1;
  }
}
export const tileKey = b => `${Math.floor(b.from.x / 32)},${Math.floor(b.from.z / 32)}`;
export const volume = b => (b.to.x - b.from.x + 1) * (b.to.y - b.from.y + 1) * (b.to.z - b.from.z + 1);
