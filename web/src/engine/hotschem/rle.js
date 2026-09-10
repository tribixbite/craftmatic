// Greedy cuboid merge over a palette-indexed grid: X-runs -> merge across Z -> merge across Y.
// Adapted from hotschem-adb.mjs scanCuboidsStream. Returns ops: [x1,y1,z1,x2,y2,z2,paletteIndex].
// index layout = (y*L + z)*W + x.
export function mergeCuboids({ W, H, L, data, airSet }) {
  const idx = (x, y, z) => (y * L + z) * W + x;
  const out = [];
  const activeY = new Map();
  for (let y = 0; y < H; y++) {
    const rects = [];
    let prevZ = new Map();
    for (let z = 0; z < L; z++) {
      const runs = [];
      let runPal = -1, runStart = 0;
      for (let x = 0; x < W; x++) {
        const p = data[idx(x, y, z)];
        const key = airSet.has(p) ? -1 : p;
        if (x === 0) { runPal = key; runStart = 0; }
        else if (key !== runPal) { if (runPal >= 0) runs.push({ x1: runStart, x2: x - 1, pal: runPal }); runPal = key; runStart = x; }
      }
      if (runPal >= 0) runs.push({ x1: runStart, x2: W - 1, pal: runPal });
      const cur = new Map();
      for (const r of runs) {
        const k = `${r.x1},${r.x2},${r.pal}`;
        const old = prevZ.get(k);
        if (old) { old.z2 = z; cur.set(k, old); }
        else cur.set(k, { ...r, z1: z, z2: z });
      }
      for (const [k, r] of prevZ) if (!cur.has(k)) rects.push(r);
      prevZ = cur;
    }
    for (const r of prevZ.values()) rects.push(r);
    const curY = new Map();
    for (const r of rects) {
      const k = `${r.x1},${r.x2},${r.z1},${r.z2},${r.pal}`;
      const old = activeY.get(k);
      if (old) { old.y2 = y; curY.set(k, old); }
      else curY.set(k, { ...r, y1: y, y2: y });
    }
    for (const [k, c] of activeY) if (!curY.has(k)) out.push([c.x1, c.y1, c.z1, c.x2, c.y2, c.z2, c.pal]);
    activeY.clear(); for (const [k, v] of curY) activeY.set(k, v);
  }
  for (const c of activeY.values()) out.push([c.x1, c.y1, c.z1, c.x2, c.y2, c.z2, c.pal]);
  return out;
}
