/**
 * X-02 (BIZ-23, BIZ-51, BIZ-52): ONE `PackProfile` option on `buildPlayableAddon`.
 *
 * The dev pack is what the phones have proved, so the first guard is that it is
 * UNCHANGED without a profile: the nimbus stand-in (a real LDraw model with a
 * flyer, an orbit ride and a figure) is built at a fixed clock and a fixed
 * pipeline stamp and every file's content hash is compared with
 * `test/fixtures/pack-profile/dev-pack.golden.json`, recorded from the code
 * BEFORE the profile existed. Regenerate it only for an intended dev-pack
 * change: `UPDATE_PACK_GOLDEN=1 bunx vitest run test/playable-addon-profile.test.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildNimbusPack, contentHashes } from './pack-profile-support.js';

const GOLDEN = 'test/fixtures/pack-profile/dev-pack.golden.json';
const FIXED_NOW = new Date('2026-11-09T12:00:00Z');

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_NOW); });
afterAll(() => { vi.useRealTimers(); });

describe('playable-addon-profile :: without a profile the dev pack is unchanged', () => {
  it('without a profile the dev pack is unchanged (file list and every file content)', async () => {
    const now = await contentHashes(await buildNimbusPack());
    if (process.env.UPDATE_PACK_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(Object.keys(now)).toEqual(Object.keys(golden));
    const changed = Object.keys(golden).filter(k => golden[k] !== now[k]);
    expect(changed).toEqual([]);
  }, 240_000);
});
