/**
 * Minimal in-memory IndexedDB stand-in — just enough of the surface
 * `web/src/viewer/ldraw/parts.ts` uses: `open` (with `onupgradeneeded`),
 * `transaction().objectStore()` and the store's `get` / `put` / `clear`.
 *
 * Why not `fake-indexeddb`: the persistent-cache tests need a database that
 * SURVIVES `vi.resetModules()` (that is the whole point — a warm browser
 * across a reload), and they need to inspect the raw records afterwards. A
 * 60-line shim owned by the test does both and adds no dependency.
 *
 * Request callbacks fire on a microtask, like the real API, so code that
 * assigns `onsuccess` after calling the method still sees it.
 */

type Rec = Map<string, unknown>;

function request<T>(work: () => T): Record<string, unknown> {
  const r: Record<string, unknown> = { onsuccess: null, onerror: null, result: undefined };
  queueMicrotask(() => {
    try {
      r['result'] = work();
      (r['onsuccess'] as (() => void) | null)?.();
    } catch {
      (r['onerror'] as (() => void) | null)?.();
    }
  });
  return r;
}

class FakeObjectStore {
  constructor(private readonly map: Rec) {}
  get(key: string): unknown { return request(() => this.map.get(key)); }
  put(value: unknown, key: string): unknown { return request(() => { this.map.set(key, value); }); }
  clear(): unknown { return request(() => { this.map.clear(); }); }
}

class FakeDatabase {
  readonly stores = new Map<string, Rec>();
  readonly objectStoreNames = { contains: (n: string): boolean => this.stores.has(n) };
  createObjectStore(name: string): FakeObjectStore {
    const map: Rec = new Map();
    this.stores.set(name, map);
    return new FakeObjectStore(map);
  }
  transaction(name: string): { objectStore: () => FakeObjectStore } {
    const map = this.stores.get(name);
    if (!map) throw new Error(`no object store ${name}`);
    return { objectStore: () => new FakeObjectStore(map) };
  }
}

/** One installed fake IndexedDB, plus direct access to its records. */
export interface FakeIdb {
  /** Records of `store`, for seeding and for asserting what survived. */
  records(store: string): Rec;
  /** Remove the database entirely (simulates a brand-new browser profile). */
  reset(): void;
  /** Restore whatever `globalThis.indexedDB` was before. */
  uninstall(): void;
}

export function installFakeIdb(dbName: string, storeName: string): FakeIdb {
  const g = globalThis as unknown as { indexedDB?: unknown };
  const previous = g.indexedDB;
  let db: FakeDatabase | null = null;

  g.indexedDB = {
    open(name: string): Record<string, unknown> {
      const fresh = db === null;
      db ??= new FakeDatabase();
      const r: Record<string, unknown> = {
        onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
        result: db,
      };
      queueMicrotask(() => {
        if (name !== dbName) { (r['onerror'] as (() => void) | null)?.(); return; }
        if (fresh) (r['onupgradeneeded'] as (() => void) | null)?.();
        queueMicrotask(() => { (r['onsuccess'] as (() => void) | null)?.(); });
      });
      return r;
    },
  };

  return {
    records(store: string): Rec {
      db ??= new FakeDatabase();
      if (!db.stores.has(store)) db.createObjectStore(store);
      return db.stores.get(store)!;
    },
    reset(): void { db = null; },
    uninstall(): void { g.indexedDB = previous; },
  };
}

export const FAKE_IDB_NAME = 'craftmatic-ldraw';
export const FAKE_IDB_STORE = 'dat-text';
