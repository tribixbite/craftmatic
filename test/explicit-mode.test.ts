/**
 * X-17 (BIZ-31): one predicate, `labelHeuristicsAllowed`, guards every title /
 * set-number heuristic site. An input in explicit mode (`PackProfile.flags.explicitOnly`:
 * BYOM models and brickgen designs) is decided by its hints, never by its title.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { labelHeuristicsAllowed, type PackProfile } from '../web/src/engine/pack-profile.js';
import { classifyVehicleKind, discoverPlayableComponents, knownScreenAnchors } from '../web/src/engine/playable-components.js';
import { planAddonScale } from '../web/src/engine/addon-scale.js';
import { listZipEntries } from '../web/src/engine/zip-utils.js';

const EXPLICIT: PackProfile = { flags: { explicitOnly: true } };
const model = (): BlockGrid => { const g = new BlockGrid(6, 3, 4); g.fill(0, 0, 0, 5, 0, 3, 'minecraft:black_concrete'); g.fill(1, 1, 1, 4, 1, 2, 'minecraft:red_concrete'); return g; };
/** The archive's entries and the kinds of the components it declares (vehicles are `car`, `plane` or `boat`). */
const build = async (opts: Parameters<typeof buildPlayableAddon>[1]): Promise<{ files: string[]; kinds: string[] }> => {
  const r = await buildPlayableAddon(model(), opts);
  return { files: listZipEntries(r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer), kinds: r.components.map(c => c.kind) };
};
const timeCircuits = (b: { files: string[] }): boolean => b.files.some(e => e.endsWith('scripts/time-machine.js'));

describe('explicit-mode :: the predicate', () => {
  it('is on for the dev pack and off for explicitOnly', () => {
    expect(labelHeuristicsAllowed({})).toBe(true);
    expect(labelHeuristicsAllowed({ packProfile: { version: [1, 0, 0] } })).toBe(true);
    expect(labelHeuristicsAllowed({ packProfile: EXPLICIT })).toBe(false);
  });
});

describe('explicit-mode :: a title never decides', () => {
  it('a model titled "10300 Time Machine" exported in explicit mode ships no time circuits', async () => {
    expect(timeCircuits(await build({ stem: 'TimeMachine', label: '10300 Time Machine' }))).toBe(true); // control: the dev pack has them
    const explicit = await build({ stem: 'TimeMachine', label: '10300 Time Machine', packProfile: EXPLICIT });
    expect(timeCircuits(explicit)).toBe(false);
    // A creator's own vehicle hint still makes it a car, but not a time machine.
    const hinted = await build({ stem: 'TimeMachine', label: '10300 Time Machine', vehicleMode: 'car', packProfile: EXPLICIT });
    expect(timeCircuits(hinted)).toBe(false);
    expect(hinted.kinds).toContain('car');
  }, 120_000);

  it('an explicit-mode title with a vehicle word stays static without a hint', async () => {
    expect((await build({ stem: 'FastCar', label: 'Fast Race Car' })).kinds).toContain('car'); // control
    expect((await build({ stem: 'FastCar', label: 'Fast Race Car', packProfile: EXPLICIT })).kinds).not.toContain('car');
    expect((await build({ stem: 'FastCar', label: 'Fast Race Car', vehicleMode: 'car', packProfile: EXPLICIT })).kinds).toContain('car');
  }, 120_000);

  it('the component, kind, anchor and scale helpers ignore the title in explicit mode', () => {
    expect(classifyVehicleKind('Fast Race Car', 'auto')).toBe('car');
    expect(classifyVehicleKind('Fast Race Car', 'auto', null, { packProfile: EXPLICIT })).toBeNull();
    expect(classifyVehicleKind('Fast Race Car', 'car', null, { packProfile: EXPLICIT })).toBe('car');
    expect(discoverPlayableComponents([], 'Fast Race Car', 'auto', undefined, { packProfile: EXPLICIT })).toEqual({ components: [], warnings: [] });
    expect(knownScreenAnchors('76252 Batcave Shadow Box')).not.toEqual([]);
    expect(knownScreenAnchors('76252 Batcave Shadow Box', { packProfile: EXPLICIT })).toEqual([]);
    expect(planAddonScale([], 'auto', 'Fast Race Car', { packProfile: EXPLICIT }).cue).not.toBe('vehicle');
  });
});

/**
 * Every call of a title / set-number function, anywhere in `web/src`, must sit
 * in a scope that mentions `labelHeuristicsAllowed` or the `heuristics` /
 * `guard` it is derived from within the 12 lines above it (or on its line).
 * A new unguarded site fails here; add the guard, or an allowlist entry WITH its reason.
 */
describe('explicit-mode :: every label-regex site is guarded', () => {
  const FILES = ['playable-addon.ts', 'schem-pipeline.ts', 'playable-components.ts', 'addon-scale.ts'];
  const SITES: RegExp[] = [
    /\bcanonFor\(/, /\bisWholeVehicleLabel\(/, /\bisSceneryLabel\(/, /\bknownScreenAnchors\(/, /\bclassifyVehicleKind\(/,
    /\bdiscoverPlayableComponents\(/, /\.test\((?:`\$\{id\} \$\{label\}`|label|setLabel)\)/,
  ];
  const GUARD = /labelHeuristicsAllowed|\bheuristics\b|\bguard\b/;
  /** Lines that DEFINE a site, import it, or are the guard's own plumbing: not call sites. */
  const SKIP = /^\s*(import |export (const|function)|\/\/|\*|\/\*)|^\s*function |const (CAR|PLANE|BOAT|HOVER|CRAFT|SCENERY)_WORDS/;
  /** Reviewed and left unguarded on purpose: `file:line-text` substring -> reason. */
  const ALLOW: Record<string, string> = {
    'playable-components.ts:/\\b(?:76252|10300)\\b': 'inside classifyVehicleKind, after its own labelHeuristicsAllowed return',
  };

  for (const file of FILES) {
    it(`${file}: no unguarded title / set-number site`, () => {
      const lines = readFileSync(`web/src/engine/${file}`, 'utf8').split('\n');
      const bad: string[] = [];
      lines.forEach((line, i) => {
        if (SKIP.test(line) || !SITES.some(re => re.test(line)) && !/76252|10300/.test(line)) return;
        if (!SITES.some(re => re.test(line)) && !/\.test\(/.test(line)) return;
        if (Object.keys(ALLOW).some(k => `${file}:${line.trim()}`.includes(k))) return;
        const window = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
        if (!GUARD.test(window)) bad.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
      expect(bad).toEqual([]);
    });
  }

  it('no other source calls a guarded title function without passing the profile', () => {
    // Callers outside the four files (scripts are dev probes and keep the dev behaviour; web/src has none today).
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of require('node:fs').readdirSync(dir) as string[]) {
        const path = `${dir}/${name}`;
        if (require('node:fs').statSync(path).isDirectory()) { walk(path); continue; }
        if (!path.endsWith('.ts') || FILES.some(f => path.endsWith(`engine/${f}`)) || path.endsWith('set-canon.ts')) continue;
        readFileSync(path, 'utf8').split('\n').forEach((l, i) => { if (/\b(canonFor|isWholeVehicleLabel|isSceneryLabel|knownScreenAnchors|discoverPlayableComponents)\(/.test(l) && !/^\s*(import|\/\/|\*)/.test(l)) hits.push(`${path}:${i + 1}`); });
      }
    };
    walk('web/src');
    expect(hits).toEqual([]);
  });
});
