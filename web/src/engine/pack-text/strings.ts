/**
 * The player-facing string table (BIZ-55, X-05): "brick" for LEGO, "figure" for minifig, "model" for set.
 * X-02 / X-03 call these builders instead of writing their own wording, so every manifest, `.lang` line and README
 * passes the lint in `./lint.ts`.
 */

/** Forbidden word -> the word a player sees instead. Longest/most specific patterns first. */
export const PLAYER_TERMS: Readonly<Record<string, string>> = {
  minifigures: 'figures', minifigure: 'figure', minifigs: 'figures', minifig: 'figure',
  LEGO: 'brick', "the set's": "the model's", 'the set': 'the model',
};

/** Case-preserving replacement: a capitalised source word gives a capitalised result. */
const keepCase = (from: string, to: string): string => (from[0] === from[0]!.toUpperCase() && from[0] !== from[0]!.toLowerCase() && from !== from.toUpperCase()
  ? to[0]!.toUpperCase() + to.slice(1) : to);

/**
 * Rewrites brand words in a string into the neutral vocabulary. Meant for text we author ourselves; it does not
 * make arbitrary third-party text safe (set numbers, themes and stamps are not rewritten: lint decides those).
 */
export function neutralise(text: string): string {
  return text
    .replace(/\bmini-?fig(ure)?s?\b/gi, m => keepCase(m, /s$/i.test(m) ? 'figures' : 'figure'))
    .replace(/\bLEGO(?:®)?\b/gi, 'brick')
    .replace(/\bthe set(?:'s)?\b/gi, m => (/'s$/i.test(m) ? "the model's" : 'the model'));
}

/** Builders take `(label, alias)`; both may be ignored. Every output is lint-clean for a clean label. */
export const playerStrings = {
  /** Creative-inventory name of the placement wand. */
  wandName: (label: string): string => `${label} Brick Wand`,
  /** Name of the figure-creator wand (was "<label> Minifig Creator Wand"). */
  creatorWandName: (label: string): string => `${label} Figure Creator Wand`,
  /** Title of the creator's documentation page (was MINIFIG-CREATOR.txt). */
  creatorTitle: (): string => 'Figure Creator',
  /** `item.spawn_egg.entity.*.name` for a spawnable entity. */
  spawnEggName: (label: string): string => `${label} Spawn Egg`,
  /** Behaviour-pack manifest description before the notice. */
  behaviourDescription: (_label: string, alias: string): string =>
    `Place with /function ${alias}; ride vehicles and use computer screens.`,
  /** Resource-pack manifest description before the notice (was "one flat 16x16 colour swatch per LEGO colour"). */
  resourceDescription: (): string =>
    'Brick geometry from the LDraw parts, one flat 16x16 colour swatch per brick colour; printed faces are the only images.',
} as const satisfies Record<string, (...a: string[]) => string>;
