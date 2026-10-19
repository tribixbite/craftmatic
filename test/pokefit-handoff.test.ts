/**
 * "Fit in a Pokéball" handoff (VIEW-19): the GLB goes to the pokefit tab only after THAT tab, from
 * pokefit's origin, says it is ready — whichever of the two (ready, model built) comes first.
 */

import { describe, it, expect, vi } from 'vitest';
import { handOffToPokefit, POKEFIT_ORIGIN, type HandoffTarget, type MessageSource } from '../web/src/viewer/pokefit-handoff.js';

/** A message bus standing in for `window`: lets the test deliver `message` events. */
function bus(): MessageSource & { emit(e: Partial<MessageEvent>): void; count(): number } {
  const listeners = new Set<(e: MessageEvent) => void>();
  return {
    addEventListener: (_t, l) => { listeners.add(l); },
    removeEventListener: (_t, l) => { listeners.delete(l); },
    emit: (e) => { for (const l of [...listeners]) l(e as MessageEvent); },
    count: () => listeners.size,
  };
}

function tab(): HandoffTarget & { sent: { message: unknown; origin: string; transfer?: Transferable[] }[] } {
  const sent: { message: unknown; origin: string; transfer?: Transferable[] }[] = [];
  return { sent, postMessage: (message, origin, transfer) => { sent.push({ message, origin, transfer }); } };
}

describe('pokefit handoff', () => {
  it('posts the model once pokefit is ready', async () => {
    const events = bus();
    const target = tab();
    const glb = new ArrayBuffer(8);
    const done = handOffToPokefit(target, Promise.resolve(glb), 'set.glb', events);
    // Ignored: another window, another origin, another message type.
    events.emit({ source: {} as MessageEventSource, origin: POKEFIT_ORIGIN, data: { type: 'pokefit:ready' } });
    events.emit({ source: target as unknown as MessageEventSource, origin: 'https://evil.example', data: { type: 'pokefit:ready' } });
    events.emit({ source: target as unknown as MessageEventSource, origin: POKEFIT_ORIGIN, data: { type: 'other' } });
    await Promise.resolve();
    expect(target.sent).toHaveLength(0);
    events.emit({ source: target as unknown as MessageEventSource, origin: POKEFIT_ORIGIN, data: { type: 'pokefit:ready' } });
    await done;
    expect(target.sent).toEqual([{ message: { type: 'pokefit:load', name: 'set.glb', data: glb }, origin: POKEFIT_ORIGIN, transfer: [glb] }]);
    expect(events.count()).toBe(0);
  });

  it('waits for a model still being built when pokefit is ready first', async () => {
    const events = bus();
    const target = tab();
    let build!: (b: ArrayBuffer) => void;
    const model = new Promise<ArrayBuffer>((r) => { build = r; });
    const done = handOffToPokefit(target, model, 'set.glb', events);
    events.emit({ source: target as unknown as MessageEventSource, origin: POKEFIT_ORIGIN, data: { type: 'pokefit:ready' } });
    await Promise.resolve();
    expect(target.sent).toHaveLength(0);
    build(new ArrayBuffer(4));
    await done;
    expect(target.sent).toHaveLength(1);
  });

  it('gives up when pokefit never says it is ready', async () => {
    vi.useFakeTimers();
    try {
      const events = bus();
      const target = tab();
      const done = handOffToPokefit(target, Promise.resolve(new ArrayBuffer(1)), 'set.glb', events, POKEFIT_ORIGIN, 1000);
      const failed = expect(done).rejects.toThrow(/pop-ups/);
      vi.advanceTimersByTime(1001);
      await failed;
      expect(target.sent).toHaveLength(0);
      expect(events.count()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
