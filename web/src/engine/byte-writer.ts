/**
 * ByteWriter — growable Uint8Array sink for binary (NBT) assembly.
 *
 * WHY (S3, 2026-09-01): the .schem/.litematic encoders used to accumulate every
 * output byte into a plain `number[]` and then copy it into a Uint8Array. At the
 * export cap (30M cells) that is a ~30M-element JS array; measured peak RSS was
 * **1.33 GB for a 0.2 MB output file** (encodeBlockData +783 MB, encodeSchemBytes
 * +325 MB) — the reported mobile OOM. Writing straight into a doubling
 * Uint8Array drops the same run to tens of MB with byte-identical output.
 */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
  }

  /** Bytes written so far. */
  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Write one byte (low 8 bits). */
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  /** Write a big-endian 16-bit value. */
  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = (v >> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  /** Write a big-endian 32-bit value. */
  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  /** Write a big-endian signed 64-bit value (NBT TAG_Long). */
  i64(v: bigint): void {
    this.u32(Number((v >> 32n) & 0xffffffffn));
    this.u32(Number(v & 0xffffffffn));
  }

  /** Write raw bytes. */
  bytes(a: Uint8Array): void {
    this.ensure(a.length);
    this.buf.set(a, this.len);
    this.len += a.length;
  }

  /** Write an NBT string: big-endian u16 byte length + UTF-8 bytes. */
  nbtString(s: string, enc: TextEncoder): void {
    const b = enc.encode(s);
    this.u16(b.length);
    this.bytes(b);
  }

  /**
   * Return the written bytes. Zero-copy view over the internal buffer when it
   * is exactly full, otherwise a trimmed copy.
   */
  toUint8Array(): Uint8Array {
    return this.len === this.buf.length ? this.buf : this.buf.slice(0, this.len);
  }
}
