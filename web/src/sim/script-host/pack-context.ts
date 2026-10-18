/**
 * WHICH behaviour pack's script is running: the key the device scopes a
 * script's dynamic properties by (quirk `dynamic-properties-per-pack`: on the
 * device every pack sees only the dynamic properties it wrote itself, on an
 * entity and on the world alike - Script API docs, `Entity.getDynamicProperty`
 * / `World.getDynamicProperty`: "dynamic properties ... are specific to the
 * behavior pack that set them"; not device-measured).
 *
 * The key is the pack's header uuid. It is known two ways:
 *
 *   - the ACTIVE pack: set while a module evaluates (`ModuleLoader.load`) and
 *     while a callback a pack registered runs (`packScoped` wraps every callback
 *     handed to `system` or to an event signal of `world` / `system`, in the pack's
 *     own view of the module);
 *   - the STACK: an `await` continuation runs outside those wrappers, so a call
 *     with no active pack reads the nearest `pack://<uuid>/...` frame (every module
 *     carries that sourceURL).
 *
 * Code outside any pack (the engine, a test harness, a scenario step) has no
 * key: it reads and writes the shared engine view (`DynamicStore`'s plain Map).
 */

/** The pack whose code is running now (undefined: none known without the stack). */
let active: string | undefined;

/** Run `fn` as pack `key`'s code (restores the previous pack afterwards). */
export function withPack<T>(key: string, fn: () => T): T {
  const was = active;
  active = key;
  try { return fn(); } finally { active = was; }
}

/** The calling pack's key: the active pack, else the nearest `pack://<key>/` frame on the stack, else undefined. */
export function callerPack(): string | undefined {
  if (active !== undefined) return active;
  const m = /pack:\/\/([^/\s)]+)\//.exec(new Error().stack ?? '');
  return m ? decodeURIComponent(m[1]!) : undefined;
}

/** The sourceURL a module of pack `key` is evaluated under (the stack reader above parses it back). */
export function moduleUrl(key: string, folder: string, path: string): string {
  return `pack://${encodeURIComponent(key)}/${folder || 'pack'}/${path}`;
}

/** Wrap a callback so it runs as pack `key`'s code; the same callback always gets the same wrapper (for `unsubscribe`). */
function scopedCallback<F extends (...args: never[]) => unknown>(key: string, fn: F, cache: WeakMap<object, unknown>): F {
  const hit = cache.get(fn) as F | undefined;
  if (hit) return hit;
  const wrapped = ((...args: never[]) => withPack(key, () => fn(...args))) as unknown as F;
  cache.set(fn, wrapped);
  return wrapped;
}

/** A generator a job runs, stepped as pack `key`'s code. */
function scopedGenerator(key: string, g: Generator<unknown, unknown, unknown>): Generator<unknown, unknown, unknown> {
  return {
    next: (v?: unknown) => withPack(key, () => g.next(v)),
    return: (v?: unknown) => withPack(key, () => g.return(v)),
    throw: (e?: unknown) => withPack(key, () => g.throw(e)),
    [Symbol.iterator]() { return this; },
  } as Generator<unknown, unknown, unknown>;
}

/** An event signal (`subscribe` / `unsubscribe`) whose callbacks run as pack `key`. */
function scopedSignal(key: string, signal: Record<string, unknown>, cache: WeakMap<object, unknown>): Record<string, unknown> {
  return new Proxy(signal, {
    get(t, prop, receiver) {
      const v = Reflect.get(t, prop, receiver);
      if (prop === 'subscribe' && typeof v === 'function') {
        // The API returns the callback it was given; a script hands that back to `unsubscribe`.
        return (cb: (ev: unknown) => void, ...rest: unknown[]) => { (v as (...a: unknown[]) => unknown)(scopedCallback(key, cb, cache), ...rest); return cb; };
      }
      if (prop === 'unsubscribe' && typeof v === 'function') return (cb: object) => (v as (c: unknown) => unknown)(cache.get(cb) ?? cb);
      return v;
    },
  });
}

/** An events object (`world.afterEvents`): every signal it hands out is scoped. */
function scopedEvents(key: string, events: Record<string, unknown>, cache: WeakMap<object, unknown>): Record<string, unknown> {
  const signals = new Map<PropertyKey, unknown>();
  return new Proxy(events, {
    get(t, prop, receiver) {
      const v = Reflect.get(t, prop, receiver);
      if (!v || typeof v !== 'object') return v;
      let s = signals.get(prop);
      if (!s) signals.set(prop, s = scopedSignal(key, v as Record<string, unknown>, cache));
      return s;
    },
  });
}

/**
 * Pack `key`'s view of `@minecraft/server`: the same module, except that every callback the pack hands to `system`
 * (`run`, `runTimeout`, `runInterval`, `runJob`, `system.afterEvents`) or to `world.afterEvents` /
 * `world.beforeEvents` runs as that pack's code. Entities, blocks and dimensions are the shared facades (a script
 * compares them by identity, and the engine looks them up by object).
 */
export function packScoped(key: string, server: Record<string, unknown>): Record<string, unknown> {
  const cache = new WeakMap<object, unknown>();
  const world = server['world'] as Record<string, unknown> | undefined;
  const system = server['system'] as Record<string, unknown> | undefined;
  const scopedWorld = world && new Proxy(world, {
    get(t, prop, receiver) {
      const v = Reflect.get(t, prop, receiver);
      return (prop === 'afterEvents' || prop === 'beforeEvents') && v && typeof v === 'object' ? (eventsOf(prop, v as Record<string, unknown>)) : v;
    },
  });
  const events = new Map<string, Record<string, unknown>>();
  const eventsOf = (name: string, v: Record<string, unknown>): Record<string, unknown> => {
    let e = events.get(name);
    if (!e) events.set(name, e = scopedEvents(key, v, cache));
    return e;
  };
  const scopedSystem = system && new Proxy(system, {
    get(t, prop, receiver) {
      const v = Reflect.get(t, prop, receiver);
      if (prop === 'afterEvents' && v && typeof v === 'object') return eventsOf('system.afterEvents', v as Record<string, unknown>);
      if (typeof v !== 'function') return v;
      if (prop === 'run' || prop === 'runTimeout' || prop === 'runInterval') return (fn: () => void, ...rest: unknown[]) => (v as (...a: unknown[]) => unknown)(scopedCallback(key, fn, cache), ...rest);
      if (prop === 'runJob') return (g: Generator<unknown, unknown, unknown>) => (v as (g: unknown) => unknown)(scopedGenerator(key, g));
      return v;
    },
  });
  return new Proxy(server, {
    get(t, prop, receiver) {
      if (prop === 'world' && scopedWorld) return scopedWorld;
      if (prop === 'system' && scopedSystem) return scopedSystem;
      return Reflect.get(t, prop, receiver);
    },
  });
}
