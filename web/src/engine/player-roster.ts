/**
 * One player roster per behaviour pack, shared by every script in it (PIN-02).
 *
 * In round 30zq's profile (26 round packs bound, 10303 and 11374 placed, one player) the scripts took a median 24 ms
 * of every 50 ms tick on both phones and 40 Pixel ticks in 69 s overran (the pinball's "client server lag").
 * `world.getAllPlayers()` was ~9 % of that busy time on the Pixel (~0.1 ms a call, ~30 calls a tick across the
 * packs' placement wands, figures, rides, hop, flyers and vehicle cameras): every pack pays its own, so the call
 * count grows with the packs bound, not with the players.
 *
 * So each pack ships `scripts/roster.js`, which wraps the real `world` once: `getAllPlayers` answers from a list kept
 * by `playerSpawn` / `playerLeave` and re-read from the game every `ROSTER_REFRESH_TICKS` (a missed event can cost at
 * most that long), dropping players that are no longer valid in between; `getDimension` keeps the dimension objects
 * it has handed out. Everything else passes straight through to the real world. Every other script in the pack takes
 * `world` from `./roster.js` instead of `@minecraft/server` (`shareScriptWorld`), so their code is unchanged.
 */

/** Ticks between full re-reads of the player list: a join or leave the events missed shows within this. */
export const ROSTER_REFRESH_TICKS = 40;

/**
 * The real `world` wrapped with a cached player roster and dimension table (see the module comment). Serialised into
 * `scripts/roster.js`, so it references nothing outside its own body.
 */
export function playerRosterWorld(base: any, system: any, refreshTicks: number): any {
  let roster: any[] | null = null;
  let refreshedAt = -Infinity;
  const tickNow = (): number => { try { return system.currentTick; } catch { return refreshedAt; } };
  const valid = (player: any): boolean => {
    if (!player) return false;
    try { return typeof player.isValid === 'function' ? player.isValid() : player.isValid !== false; } catch { return false; }
  };
  // Read lazily, on the first call, never at load: `getAllPlayers` throws in early execution, and a roster read
  // then would stay empty until the next refresh.
  const refresh = (): void => {
    try { roster = base.getAllPlayers(); refreshedAt = tickNow(); } catch { roster = null; }
  };
  try {
    base.afterEvents.playerSpawn.subscribe((event: any) => {
      if (!roster || !event?.player) return;
      // A respawn may hand out a new handle: keep one entry per id, the latest.
      roster = roster.filter(other => !other || other.id !== event.player.id);
      roster.push(event.player);
    });
    base.afterEvents.playerLeave.subscribe((event: any) => {
      if (roster) roster = roster.filter(other => !other || other.id !== event?.playerId);
    });
  } catch { /* no events: the periodic re-read alone keeps the roster */ }
  const getAllPlayers = (): any[] => {
    const now = tickNow();
    if (!roster || !(now - refreshedAt < refreshTicks) || now < refreshedAt) refresh();
    else roster = roster.filter(valid);
    // A copy: callers filter and sort what they get.
    return roster ? roster.slice() : base.getAllPlayers();
  };
  const dimensions = new Map<string, any>();
  const getDimension = (id: string): any => {
    let dimension = dimensions.get(id);
    if (!dimension) { dimension = base.getDimension(id); dimensions.set(id, dimension); }
    return dimension;
  };
  return new Proxy(base, {
    get(target: any, key: string | symbol) {
      if (key === 'getAllPlayers') return getAllPlayers;
      if (key === 'getDimension') return getDimension;
      const value = target[key];
      // Native methods need the real world as `this`.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The pack's `scripts/roster.js`: the shared, wrapped `world`. */
export function playerRosterScript(): string {
  return `import { world as gameWorld, system } from '@minecraft/server';\n`
    + `export const world = (${playerRosterWorld.toString()})(gameWorld, system, ${ROSTER_REFRESH_TICKS});\n`;
}

/** Matches a script's import from `@minecraft/server` (either quote style). */
const SERVER_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])@minecraft\/server\2;?/;

/**
 * One script's source with `world` taken from `./roster.js` instead of `@minecraft/server`; unchanged when it does
 * not import `world` (or already takes it from the roster).
 */
export function rosterScriptSource(source: string): string {
  const match = SERVER_IMPORT.exec(source);
  if (!match) return source;
  const names = match[1]!.split(',').map(name => name.trim()).filter(Boolean);
  if (!names.includes('world')) return source;
  const rest = names.filter(name => name !== 'world');
  const replacement = (rest.length ? `import { ${rest.join(', ')} } from '@minecraft/server';\n` : '') + `import { world } from './roster.js';`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

/**
 * Every script of the behaviour pack at `bp` takes the shared roster's `world`, and the pack gains `scripts/roster.js`.
 * `files` is rewritten in place; text is UTF-8.
 */
export function shareScriptWorld(files: Array<{ name: string; data: Uint8Array }>, bp: string): void {
  const dir = `${bp}scripts/`, rosterName = `${dir}roster.js`;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let used = false;
  for (const file of files) {
    if (!file.name.startsWith(dir) || !file.name.endsWith('.js') || file.name === rosterName) continue;
    const source = decoder.decode(file.data);
    const shared = rosterScriptSource(source);
    if (shared !== source) { file.data = encoder.encode(shared); used = true; }
  }
  if (used && !files.some(file => file.name === rosterName)) files.push({ name: rosterName, data: encoder.encode(playerRosterScript()) });
}
