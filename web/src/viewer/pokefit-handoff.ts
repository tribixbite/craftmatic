/**
 * "Fit in a Pokéball": hand the current model to pokefit.party (VIEW-19).
 *
 * pokefit fits a figure inside a printed Pokéball, cuts magnet pockets, turns the model's colours into
 * filaments and writes the Bambu Studio 3MF, so craftmatic needs no Bambu writer of its own. The two apps
 * share files, not code: craftmatic opens pokefit in a new tab and, once that tab announces
 * `{type: "pokefit:ready"}` to its opener, posts `{type: "pokefit:load", name, data: ArrayBuffer}` (the
 * GLB). pokefit accepts the message only from its trusted origins (craftmatic.click,
 * tribixbite.github.io, localhost); pokefit's side is `web/src/handoff.ts` in tribixbite/pokefit.
 */

export const POKEFIT_URL = 'https://pokefit.party/';
export const POKEFIT_ORIGIN = 'https://pokefit.party';
/** pokefit loads its engine before it says it is ready; a minute covers a slow phone. */
export const READY_TIMEOUT_MS = 60_000;

/** The pokefit tab, as far as the handoff needs it (a `Window` in the app; a stub in tests). */
export interface HandoffTarget {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

/** Where pokefit's `ready` message arrives (`window` in the app). */
export interface MessageSource {
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}

/**
 * Open pokefit in a new tab. Call it straight from the click/change handler, before any `await`, or the
 * browser's pop-up blocker refuses it. Not `noopener`: pokefit needs `window.opener` to say it is ready.
 */
export function openPokefit(url: string = POKEFIT_URL): Window | null {
  return window.open(url, '_blank');
}

/**
 * Send `model` (GLB bytes, possibly still being built) to the pokefit tab `target` once it is ready.
 * Listening starts at once, so a `ready` that arrives while the model is still baking is not missed.
 * Resolves when the model is posted; rejects if pokefit never says it is ready within `timeoutMs`.
 */
export function handOffToPokefit(
  target: HandoffTarget,
  model: Promise<ArrayBuffer>,
  name: string,
  events: MessageSource = window,
  origin: string = POKEFIT_ORIGIN,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      events.removeEventListener('message', onMessage);
      reject(new Error('pokefit did not open in time: allow pop-ups for this site and try again.'));
    }, timeoutMs);
    function onMessage(e: MessageEvent): void {
      const data = e.data as { type?: unknown } | null;
      if (e.source !== target || e.origin !== origin || data?.type !== 'pokefit:ready') return;
      clearTimeout(timer);
      events.removeEventListener('message', onMessage);
      resolve();
    }
    events.addEventListener('message', onMessage);
  });
  return Promise.all([ready, model]).then(([, data]) => {
    // Transfer the buffer rather than copy it: a LEGO set's GLB can be tens of MB.
    target.postMessage({ type: 'pokefit:load', name, data }, origin, [data]);
  });
}
