/**
 * An entity's (or the world's) dynamic properties, scoped by the behaviour pack that wrote them (quirk
 * `dynamic-properties-per-pack`; the pack keys come from `script-host/pack-context.ts`): over the engine's
 * shared view. The Map itself is the ENGINE's view (an
 * adapter, a test or the walk preview reads and writes it directly: a value written there is seen by every pack,
 * as a test host's seeded state should be). A SCRIPT reads and writes through `getFor` / `setFor` with its pack's
 * key: once a pack has written a key, only packs holding their own value of it see one - another pack reads
 * undefined, as on the device. Every script write is mirrored into the engine view (last writer wins there).
 */
export class DynamicStore extends Map<string, unknown> {
  /** Values by pack key, for keys a script wrote. */
  private readonly byPack = new Map<string, Map<string, unknown>>();
  /** The packs holding their own value of a key (absent or empty: the key is the engine's, shared). */
  private readonly holders = new Map<string, Set<string>>();

  /** An engine write: the value is shared by every pack again. */
  override set(k: string, v: unknown): this {
    this.forget(k);
    return super.set(k, v);
  }

  override delete(k: string): boolean { this.forget(k); return super.delete(k); }

  override clear(): void { this.byPack?.clear(); this.holders?.clear(); super.clear(); }

  private forget(k: string): void {
    // `Map`'s constructor calls `set` before the fields exist.
    if (!this.holders) return;
    for (const p of this.holders.get(k) ?? []) this.byPack.get(p)?.delete(k);
    this.holders.delete(k);
  }

  /** What pack `pack` reads for `k` (no pack: the engine view). */
  getFor(pack: string | undefined, k: string): unknown {
    if (pack === undefined) return super.get(k);
    const h = this.holders.get(k);
    if (!h || !h.size) return super.get(k);
    return this.byPack.get(pack)?.get(k);
  }

  /** Pack `pack` writes `k` (undefined removes its value); mirrored into the engine view. */
  setFor(pack: string | undefined, k: string, v: unknown): void {
    if (pack === undefined) { if (v === undefined) this.delete(k); else this.set(k, v); return; }
    // From a pack's first write on, the key is per-pack (the device has no shared value; an engine-seeded one is a
    // test host's convenience): its holders read their own values, every other pack reads undefined.
    const own = this.byPack.get(pack) ?? new Map<string, unknown>();
    this.byPack.set(pack, own);
    const h = this.holders.get(k) ?? new Set<string>();
    this.holders.set(k, h);
    if (v === undefined) {
      own.delete(k);
      h.delete(pack);
      // The engine view keeps the value another holder wrote, else drops the key.
      const other = [...h].map(p => this.byPack.get(p)?.get(k)).find(x => x !== undefined);
      if (other === undefined) super.delete(k); else super.set(k, other);
      if (!h.size) this.holders.delete(k);
      return;
    }
    own.set(k, v);
    h.add(pack);
    super.set(k, v);
  }

  /** The keys pack `pack` sees. */
  keysFor(pack: string | undefined): string[] {
    if (pack === undefined) return [...super.keys()];
    return [...super.keys()].filter(k => { const h = this.holders.get(k); return !h || !h.size || this.byPack.get(pack)?.has(k); });
  }

  /** Pack `pack` clears every value it sees (`clearDynamicProperties`). */
  clearFor(pack: string | undefined): void {
    if (pack === undefined) { this.clear(); return; }
    for (const k of this.keysFor(pack)) {
      const h = this.holders.get(k);
      if (!h || !h.size) super.delete(k); else this.setFor(pack, k, undefined);
    }
  }
}
