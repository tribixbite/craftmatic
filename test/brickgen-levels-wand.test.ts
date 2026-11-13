/**
 * LSCALE: the Brick Wand shows a landmark pack's detail level and suggests a size that fits the room at the pin,
 * driven through the serialised runtime on the headless simulator (test/_placement-host.ts).
 */
import { describe, expect, it } from 'vitest';
import { host } from './_placement-host.js';
import type { PlacementDetail } from '../web/src/brickgen/levels/levels.js';
import { lintText } from '../web/src/engine/pack-text/lint.js';

const tile = { identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 4, height: 2, length: 2, nonAir: 4 };
const detail: PlacementDetail = {
  studsPerMetre: 2, extentM: { x: 12, y: 8, z: 6 },
  suggestion: { pct: 400, text: 'Suggested size: 400 percent. At this size the design has two studs to the metre: tapering spires.' },
  otherLevels: [{ studsPerMetre: 4, text: 'A finer design is in the four studs pack.' }],
};
const spec = { stem: 'lm', label: 'Landmark', width: 4, height: 2, length: 2, tiles: [tile], actors: [], detail, settleTicks: 1, finalHoldTicks: 1 };

describe('brickgen-levels wand', () => {
  it('ships the detail text and offers "Suggest a size here" only for a pack with levels', async () => {
    const h = host(spec);
    expect(h.assets.script).toContain('Suggested size: 400 percent.');
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    expect(h.buttons.at(-1)!.some(l => l.startsWith('Suggest a size here'))).toBe(true);
    const plain = host({ ...spec, detail: undefined });
    await plain.open({ action: 'Pin corner at my feet' }, { canceled: true });
    expect(plain.buttons.at(-1)!.some(l => l.startsWith('Suggest a size here'))).toBe(false);
  });

  it('sets the suggested size when the room is clear, and the largest step that fits when it is not', async () => {
    const clear = host(spec);
    await clear.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await clear.open({ action: 'Suggest a size here' }, { canceled: true });
    await clear.flush(4000);
    await clear.open({}, { canceled: true });
    expect(clear.buttons.at(-1)!.some(l => l.startsWith('Size 400 percent'))).toBe(true);

    const blocked = host(spec);
    await blocked.open({ action: 'Pin corner at my feet' }, { canceled: true });
    const anchor = { x: Math.floor(blocked.player.location.x), y: Math.floor(blocked.player.location.y), z: Math.floor(blocked.player.location.z) };
    // A wall at 8 blocks east of the pin, inside the 12- and 16-block footprints but not the 8-block one.
    blocked.blocks.set(`${anchor.x + 8},${anchor.y + 1},${anchor.z}`, { typeId: 'minecraft:stone' });
    await blocked.open({ action: 'Suggest a size here' }, { canceled: true });
    await blocked.flush(4000);
    await blocked.open({}, { canceled: true });
    expect(blocked.buttons.at(-1)!.some(l => l.startsWith('Size 200 percent'))).toBe(true);
    expect(blocked.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('does not fit here'));
  });

  it('the suggestion wording passes the marketplace text lint', () => {
    expect(lintText(`${detail.suggestion.text} ${detail.otherLevels[0]!.text}`, { surface: 'prose' })).toEqual([]);
  });
});
