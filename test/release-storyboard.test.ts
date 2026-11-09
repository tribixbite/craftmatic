import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderShotBrief, storyboardDuration, validateStoryboard } from '../web/src/release/storyboard.js';

const ROOT = join(__dirname, '..');
const SHA = 'a'.repeat(64);

/** A valid 36 s storyboard: three 12 s shots. */
const board = (): Record<string, any> => ({
  product: 'fixture',
  status: 'locked',
  aspects: ['16:9', '9:16'],
  shots: [1, 2, 3].map(n => ({
    id: `s${n}`, title: `Shot ${n}`, source: 'device', durationSec: 12, camera: 'third-person-chase',
    packSha256: SHA, wandSizePct: 100, position: { x: 0, y: 64, z: 0, yawDeg: 0 },
    action: 'Drive past.', framing: { '16:9': 'wide', '9:16': 'tall' },
  })),
});

describe('release-storyboard', () => {
  it('a storyboard longer than 45 s or a shot without a pack sha256 is refused', () => {
    expect(validateStoryboard(board())).toEqual([]);
    const long = board();
    long.shots[0].durationSec = 20; // 44 s: still legal
    expect(validateStoryboard(long)).toEqual([]);
    long.shots[1].durationSec = 20; // 52 s
    expect(validateStoryboard(long).join('\n')).toMatch(/52 s .*45/);
    const noSha = board();
    delete noSha.shots[1].packSha256;
    expect(validateStoryboard(noSha).join('\n')).toMatch(/s2.*packSha256/);
  });

  it('a storyboard shorter than 30 s is refused', () => {
    const short = board();
    short.shots.pop();
    expect(storyboardDuration(short.shots)).toBe(24);
    expect(validateStoryboard(short).join('\n')).toMatch(/24 s .*30/);
  });

  it('both aspect cuts are required, and every shot frames both', () => {
    const one = board();
    one.aspects = ['16:9'];
    expect(validateStoryboard(one).join('\n')).toMatch(/9:16/);
    const noFrame = board();
    delete noFrame.shots[0].framing['9:16'];
    expect(validateStoryboard(noFrame).join('\n')).toMatch(/s1.*9:16/);
  });

  it('refuses a wand size the pack does not ship, a bad position and an unknown camera', () => {
    const b = board();
    b.shots[0].wandSizePct = 175;
    b.shots[1].position = { x: 0, y: 'up', z: 0, yawDeg: 0 };
    b.shots[2].camera = 'drone';
    const text = validateStoryboard(b).join('\n');
    expect(text).toMatch(/s1.*wandSizePct/);
    expect(text).toMatch(/s2.*position/);
    expect(text).toMatch(/s3.*camera/);
  });

  it('refuses duplicate shot ids and a malformed sha256', () => {
    const b = board();
    b.shots[1].id = 's1';
    b.shots[2].packSha256 = 'xyz';
    const text = validateStoryboard(b).join('\n');
    expect(text).toMatch(/duplicate shot id s1/);
    expect(text).toMatch(/packSha256/);
  });

  it('the all-zero draft sha256 is legal only while the storyboard is a draft', () => {
    const b = board();
    for (const s of b.shots) s.packSha256 = '0'.repeat(64);
    expect(validateStoryboard(b).join('\n')).toMatch(/draft/);
    b.status = 'draft';
    expect(validateStoryboard(b)).toEqual([]);
  });

  it('the brief section lists every device shot with its pack, size and position', () => {
    const b = board();
    b.shots[2].source = 'offline';
    const text = renderShotBrief(b as never);
    expect(text).toContain('s1');
    expect(text).toContain('a'.repeat(64));
    expect(text).toContain('100 %');
    expect(text).toContain('x 0, y 64, z 0');
    expect(text).not.toContain('Shot 3');
    expect(text).toContain('180 s');
  });

  it('the sampler storyboard is valid and covers one car, a door and a seat', () => {
    const b = JSON.parse(readFileSync(join(ROOT, 'release/media/sampler.storyboard.json'), 'utf8'));
    expect(validateStoryboard(b)).toEqual([]);
    expect(b.product).toBe('sampler');
    const text = JSON.stringify(b.shots).toLowerCase();
    for (const word of ['car', 'door', 'seat']) expect(text).toContain(word);
  });
});
