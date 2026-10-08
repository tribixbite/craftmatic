/**
 * Which blocks of a dimension were ever written (a test host's Undo check, the
 * placement host's block map): one BIT per block, in a 512-byte bitmap per 16³
 * section touched, keyed like the voxel store's sections.
 *
 * Until 2026-10-08 this was a `Map<"x,y,z", id>`: one string key and a Map
 * entry per block ever written, ~100 bytes each, kept for the whole run. A
 * placement at 300-400 % clears and re-lays boxes of tens of millions of
 * blocks, and `scripts/_seat_egress_sweep.ts` on 76457 grew past 64 GB and
 * crashed Bun (`TODO(seat-sweep-memory)`, TASKS-BEDROCK-ADDON.md). The same
 * record now costs 512 bytes per touched section.
 *
 * Read as the old Map was: `has("x,y,z")`, `keys()` (section by section, each
 * in x, y, z order - not the order of the writes), `size`.
 */

/** A section's key from its section coordinates (the voxel store's packing: x/z within ±2^21, y within ±32 sections). */
const sectionKey = (sx: number, sy: number, sz: number): number => ((sx + 2097152) * 64 + (sy + 32)) * 4194304 + (sz + 2097152);

/** The blocks a dimension has had written. */
export class WriteLog {
  private readonly bits = new Map<number, { sx: number; sy: number; sz: number; map: Uint8Array }>();
  private count = 0;

  /** Record a write at block (x, y, z) (integers). */
  add(x: number, y: number, z: number): void {
    const sx = x >> 4, sy = y >> 4, sz = z >> 4, k = sectionKey(sx, sy, sz);
    let s = this.bits.get(k);
    if (!s) this.bits.set(k, s = { sx, sy, sz, map: new Uint8Array(512) });
    const i = ((x & 15) * 16 + (y & 15)) * 16 + (z & 15);
    const byte = i >> 3, bit = 1 << (i & 7);
    if (!(s.map[byte]! & bit)) { s.map[byte]! |= bit; this.count++; }
  }

  /** Whether block (x, y, z) was written. */
  hasBlock(x: number, y: number, z: number): boolean {
    const s = this.bits.get(sectionKey(x >> 4, y >> 4, z >> 4));
    if (!s) return false;
    const i = ((x & 15) * 16 + (y & 15)) * 16 + (z & 15);
    return (s.map[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  /** Whether the block `"x,y,z"` was written (the old Map's key). */
  has(key: string): boolean {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && this.hasBlock(x, y, z);
  }

  /** How many distinct blocks were written. */
  get size(): number { return this.count; }

  /** Every written block as `"x,y,z"`. */
  *keys(): IterableIterator<string> {
    for (const s of this.bits.values()) {
      for (let i = 0; i < 4096; i++) {
        if (!(s.map[i >> 3]! & (1 << (i & 7)))) continue;
        const dx = i >> 8, dy = (i >> 4) & 15, dz = i & 15;
        yield `${s.sx * 16 + dx},${s.sy * 16 + dy},${s.sz * 16 + dz}`;
      }
    }
  }
}
