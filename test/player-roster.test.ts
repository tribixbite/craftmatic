import { describe, expect, it } from 'vitest';
import { playerRosterScript, playerRosterWorld, rosterScriptSource, ROSTER_REFRESH_TICKS, shareScriptWorld } from '../web/src/engine/player-roster.js';

/** A fake `world` counting its native calls, with the two events the roster listens to. */
function fakeWorld(players: any[]) {
  const listeners: Record<string, Array<(e: any) => void>> = { spawn: [], leave: [] };
  const counts = { players: 0, dimension: 0 };
  const world = {
    marker: 'real',
    getAllPlayers() { counts.players++; return [...players]; },
    getDimension(id: string) { counts.dimension++; return { id }; },
    whoAmI() { return this; },
    afterEvents: {
      playerSpawn: { subscribe: (fn: (e: any) => void) => listeners.spawn.push(fn) },
      playerLeave: { subscribe: (fn: (e: any) => void) => listeners.leave.push(fn) },
    },
  };
  return { world, counts, listeners, players };
}
const player = (id: string) => ({ id, isValid: true });

describe('the shared player roster (PIN-02: ~30 getAllPlayers calls a tick across the packs, ~9 % of the scripts\' busy time on the Pixel)', () => {
  it('reads the game once per refresh window, and keeps joins and leaves from the events in between', () => {
    const { world, counts, listeners, players } = fakeWorld([player('a')]);
    const system = { currentTick: 100 };
    const wrapped = playerRosterWorld(world, system, ROSTER_REFRESH_TICKS);
    expect(wrapped.getAllPlayers().map((p: any) => p.id)).toEqual(['a']);
    for (let t = 101; t < 100 + ROSTER_REFRESH_TICKS; t++) { system.currentTick = t; wrapped.getAllPlayers(); wrapped.getAllPlayers(); }
    expect(counts.players).toBe(1);
    // A join between refreshes is seen at once, from the event; a leave too.
    const b = player('b');
    players.push(b);
    for (const fn of listeners.spawn) fn({ player: b });
    expect(wrapped.getAllPlayers().map((p: any) => p.id)).toEqual(['a', 'b']);
    for (const fn of listeners.leave) fn({ playerId: 'a' });
    expect(wrapped.getAllPlayers().map((p: any) => p.id)).toEqual(['b']);
    expect(counts.players).toBe(1);
    // A player gone invalid (unloaded, left without an event) drops out before the refresh.
    b.isValid = false;
    expect(wrapped.getAllPlayers()).toEqual([]);
    // The refresh re-reads the game: a missed event costs at most ROSTER_REFRESH_TICKS.
    system.currentTick = 100 + ROSTER_REFRESH_TICKS;
    players.splice(0, players.length, player('c'));
    expect(wrapped.getAllPlayers().map((p: any) => p.id)).toEqual(['c']);
    expect(counts.players).toBe(2);
  });

  it('retries a read that failed in early execution instead of keeping an empty roster', () => {
    const { world, counts } = fakeWorld([player('a')]);
    let early = true;
    const real = world.getAllPlayers;
    world.getAllPlayers = function () { if (early) { counts.players++; throw new Error('early execution'); } return real.call(this); };
    const system = { currentTick: 0 };
    const wrapped = playerRosterWorld(world, system, ROSTER_REFRESH_TICKS);
    expect(() => wrapped.getAllPlayers()).toThrow('early execution');
    early = false;
    system.currentTick = 1;
    expect(wrapped.getAllPlayers().map((p: any) => p.id)).toEqual(['a']);
  });

  it('hands out copies, keeps dimensions, and passes everything else to the real world with it as `this`', () => {
    const { world, counts } = fakeWorld([player('a')]);
    const wrapped = playerRosterWorld(world, { currentTick: 5 }, ROSTER_REFRESH_TICKS);
    wrapped.getAllPlayers().pop();
    expect(wrapped.getAllPlayers()).toHaveLength(1);
    expect(wrapped.getDimension('overworld')).toBe(wrapped.getDimension('overworld'));
    expect(counts.dimension).toBe(1);
    expect(wrapped.marker).toBe('real');
    expect(wrapped.whoAmI()).toBe(world);
    expect(wrapped.afterEvents).toBe(world.afterEvents);
  });

  it('rewrites a script to take `world` from the roster, and leaves a script without it alone', () => {
    expect(rosterScriptSource(`import { world, system, LinearSpline } from '@minecraft/server';\nworld.getAllPlayers();\n`))
      .toBe(`import { system, LinearSpline } from '@minecraft/server';\nimport { world } from './roster.js';\nworld.getAllPlayers();\n`);
    expect(rosterScriptSource(`import { world } from "@minecraft/server";\nimport { ActionFormData } from "@minecraft/server-ui";\n`))
      .toBe(`import { world } from './roster.js';\nimport { ActionFormData } from "@minecraft/server-ui";\n`);
    const untouched = `import { system } from '@minecraft/server';\nimport './coaster.js';\n`;
    expect(rosterScriptSource(untouched)).toBe(untouched);
  });

  it('adds scripts/roster.js to a pack whose scripts use world, and the roster script is self-contained', () => {
    const enc = new TextEncoder(), dec = new TextDecoder();
    const files = [
      { name: 'BP/scripts/main.js', data: enc.encode(`import './coaster.js';\n`) },
      { name: 'BP/scripts/coaster.js', data: enc.encode(`import { world, system } from '@minecraft/server';\n`) },
      { name: 'BP/entities/car.json', data: enc.encode('{}') },
    ];
    shareScriptWorld(files, 'BP/');
    expect(dec.decode(files[1]!.data)).toContain(`import { world } from './roster.js';`);
    expect(files.map(f => f.name)).toContain('BP/scripts/roster.js');
    const roster = playerRosterScript();
    expect(roster).toContain(`from '@minecraft/server'`);
    expect(roster).toContain('export const world');
    // The serialised wrapper parses on its own (it is shipped as text).
    const body = roster.split('\n').filter(line => !line.startsWith('import')).join('\n').replace('export const world =', 'return');
    const wrap = new Function('gameWorld', 'system', body);
    const { world } = fakeWorld([player('z')]);
    expect(wrap(world, { currentTick: 0 }).getAllPlayers().map((p: any) => p.id)).toEqual(['z']);
  });
});
