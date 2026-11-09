/**
 * D-09 / BIZ-57, BIZ-58, BIZ-59: the channel bundle generator over `release/channels/<channel>.json`.
 * It writes a folder per channel (fields, description, images, the file, a checklist) and uploads nothing.
 * Fixture media are generated images of the exact preset sizes; no real render is needed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  assembleDescription, donationLinksLast, generateChannelBundles, linkProblems, loadChannelSpecs, renderUnverifiedLimits,
  type GenerationResult, type PreparedRelease,
} from '../web/src/release/channels.js';
import { lintText } from '../web/src/engine/pack-text/lint.js';
import { MAX_BYTES_EXCLUSIVE, MAX_SIDE_EXCLUSIVE, MEDIA_PRESETS, presetById } from '../web/src/release/media-presets.js';

const ROOT = join(__dirname, '..');
const SPEC_DIR = join(ROOT, 'release', 'channels');

/** A flat-colour image of the preset's exact size, in the given format. */
async function fixtureImage(path: string, width: number, height: number, format: 'png' | 'jpeg' | 'gif'): Promise<void> {
  const img = sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 120 } } });
  await (format === 'png' ? img.png() : format === 'jpeg' ? img.jpeg() : img.gif()).toFile(path);
}

/** A complete media folder: every preset the specs name, with several screenshots. */
async function fixtureMedia(dir: string, skip: readonly string[] = []): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const put = async (id: string, name: string, format: 'png' | 'gif' = 'png'): Promise<void> => {
    if (skip.includes(id)) return;
    const p = presetById(id);
    const w = p.kind === 'turntable' ? p.gifWidth : p.width;
    const h = p.kind === 'turntable' ? Math.round(p.gifWidth * p.height / p.width) : p.height;
    await fixtureImage(join(dir, name), w, h, format);
  };
  await put('cf-logo', 'cf-logo.png');
  for (const n of [1, 2, 3]) await put('screenshot', `screenshot-${n}.png`);
  await put('itch-cover', 'itch-cover.png');
  await put('itch-cover-2x', 'itch-cover-2x.png');
  await put('mcpedl-thumb', 'mcpedl-thumb.png');
  await put('turntable', 'turntable.gif', 'gif');
}

function fixtureRelease(root: string, mediaDir: string): PreparedRelease {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'brick-sampler-1.0.0.mcaddon'), 'fixture addon bytes');
  writeFileSync(join(dist, 'brick-sampler-1.0.0.zip'), 'fixture zip bytes');
  return {
    product: 'sampler', version: '1.0.0', slug: 'brick-sampler', brand: null, mediaDir,
    artifacts: [join(dist, 'brick-sampler-1.0.0.mcaddon'), join(dist, 'brick-sampler-1.0.0.zip')],
    changelogText: 'Added\n- First public build.\n',
  };
}

describe('release-channels: the generated bundles', () => {
  let out = '';
  let result: GenerationResult;
  const specs = loadChannelSpecs(SPEC_DIR);
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'd09-'));
    const media = join(root, 'media');
    await fixtureMedia(media);
    out = join(root, 'channels');
    result = await generateChannelBundles(fixtureRelease(root, media), specs, out);
  });

  it('the curseforge logo is a square PNG of at least 400 px, under 2000 px and 4 MB', async () => {
    const logo = join(out, 'curseforge', 'images', 'logo.png');
    expect(existsSync(logo)).toBe(true);
    const meta = await sharp(logo).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(meta.height);
    expect(meta.width!).toBeGreaterThanOrEqual(400);
    expect(meta.width!).toBeLessThan(MAX_SIDE_EXCLUSIVE);
    expect(readFileSync(logo).length).toBeLessThan(MAX_BYTES_EXCLUSIVE);
  });

  it('the itch cover is exactly 630x500', async () => {
    const cover = await sharp(join(out, 'itch', 'images', 'cover.png')).metadata();
    expect([cover.width, cover.height]).toEqual([630, 500]);
    const cover2 = await sharp(join(out, 'itch', 'images', 'cover-2x.png')).metadata();
    expect([cover2.width, cover2.height]).toEqual([1260, 1000]);
  });

  it('the mcpedl thumbnail is named exactly MCPEDL and every written image is under 2000 px and 4 MB', async () => {
    expect(existsSync(join(out, 'mcpedl', 'images', 'MCPEDL.png'))).toBe(true);
    for (const b of result.bundles) {
      for (const f of b.files.filter(x => x.path.startsWith('images/'))) {
        const m = await sharp(join(out, b.channel, f.path)).metadata();
        expect(m.width!).toBeLessThan(MAX_SIDE_EXCLUSIVE);
        expect(m.height!).toBeLessThan(MAX_SIDE_EXCLUSIVE);
        expect(f.bytes).toBeLessThan(MAX_BYTES_EXCLUSIVE);
      }
    }
  });

  it('every checklist item starts unchecked and names the user as approver', () => {
    expect(result.bundles.length).toBe(specs.length);
    for (const b of result.bundles) {
      expect(b.checklist.length).toBeGreaterThan(0);
      for (const it of b.checklist) {
        expect(it.approved).toBe(false);
        expect(it.approver).toBe('user');
      }
      const md = readFileSync(join(out, b.channel, 'CHECKLIST.md'), 'utf8');
      const boxes = md.split('\n').filter(l => /^- \[.\]/.test(l));
      expect(boxes.length).toBe(b.checklist.length);
      for (const l of boxes) {
        expect(l.startsWith('- [ ] ')).toBe(true);
        expect(l).toContain('approver: user');
      }
    }
  });

  it('no listing carries an ad-gated or shortener link', () => {
    for (const b of result.bundles) {
      for (const name of ['description.md', 'fields.json', 'CHECKLIST.md']) {
        expect(linkProblems(readFileSync(join(out, b.channel, name), 'utf8'))).toEqual([]);
      }
    }
    expect(linkProblems('get it [here](https://bit.ly/abc) or https://adf.ly/x or https://sub.linkvertise.com/y')).toHaveLength(3);
    expect(linkProblems('[ok](https://example.com/a) and https://<site>/go/kofi')).toEqual([]);
  });

  it('donation links come last in the CurseForge description', () => {
    const d = readFileSync(join(out, 'curseforge', 'description.md'), 'utf8');
    const urls = d.match(/https?:\/\/[^\s)]+/g) ?? [];
    expect(urls.some(u => /\/go\/(kofi|patreon)/.test(u))).toBe(true);
    expect(donationLinksLast(d)).toBe(true);
    expect(donationLinksLast('[tip](https://x/go/kofi) then [more](https://x/packs)')).toBe(false);
    // The assembler enforces it even when the spec lists a donation block early.
    const text = assembleDescription([
      { id: 'a', kind: 'donation', markdown: '[tip](https://x/go/kofi)' },
      { id: 'b', kind: 'legal', markdown: 'legal text' },
      { id: 'c', kind: 'body', markdown: '[more](https://x/packs)' },
    ], {});
    expect(text.indexOf('packs')).toBeLessThan(text.indexOf('kofi'));
    expect(text.indexOf('kofi')).toBeLessThan(text.indexOf('legal text'));
  });

  it('unverified limits are listed in UNVERIFIED-LIMITS.md for the top of APPROVAL.md', () => {
    const md = readFileSync(join(out, 'UNVERIFIED-LIMITS.md'), 'utf8');
    expect(result.unverified.length).toBeGreaterThan(0);
    for (const u of result.unverified) expect(md).toContain(`${u.channel}: ${u.item}`);
    expect(md).toContain('curseforge: field "summary" length');
    expect(md).toContain('mcpedl: image "thumbnail" size');
    expect(renderUnverifiedLimits([])).toContain('None.');
  });

  it('the generated listing text passes the forbidden-terms lint', () => {
    for (const b of result.bundles) {
      const description = readFileSync(join(out, b.channel, 'description.md'), 'utf8');
      expect(lintText(description, { surface: 'prose' })).toEqual([]);
      const name = b.fields.name ?? b.fields.title;
      if (typeof name === 'string') expect(lintText(name, { surface: 'name' })).toEqual([]);
    }
  });

  it('only the brand, contact and site placeholders (and the user\'s own account name) remain visible', () => {
    expect(result.placeholders).toEqual(['<Brand>', '<brand>', '<email>', '<site>', '<user>']);
  });

  it('copies the release files and the changelog, and writes nothing outside the output folder', () => {
    expect(readdirSync(join(out, 'curseforge', 'file')).sort()).toEqual(['brick-sampler-1.0.0.mcaddon', 'brick-sampler-1.0.0.zip']);
    expect(readdirSync(join(out, 'itch', 'file'))).toEqual(['brick-sampler-1.0.0.mcaddon']);
    expect(readFileSync(join(out, 'curseforge', 'changelog.md'), 'utf8')).toContain('First public build');
    expect(existsSync(join(out, 'mcpedl', 'file'))).toBe(false);
  });

  it('the itch upload command is prepared, not run', () => {
    const itch = result.bundles.find(b => b.channel === 'itch')!;
    const up = itch.checklist.find(c => c.id === 'itch.upload')!;
    expect(up.exactCommandOrUrl).toContain('output/releases/sampler/1.0.0/dist');
    expect(up.exactCommandOrUrl).toContain('--userversion 1.0.0');
  });

  it('is deterministic: a second run writes identical text files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd09b-'));
    const media = join(root, 'media');
    await fixtureMedia(media);
    const out2 = join(root, 'channels');
    await generateChannelBundles(fixtureRelease(root, media), specs, out2);
    for (const c of ['curseforge', 'mcpedl', 'itch']) {
      for (const n of ['fields.json', 'description.md', 'limits.json', 'CHECKLIST.md']) {
        expect(readFileSync(join(out2, c, n), 'utf8')).toBe(readFileSync(join(out, c, n), 'utf8'));
      }
    }
  });
});

describe('release-channels: refusals', () => {
  const specs = loadChannelSpecs(SPEC_DIR);
  it('a missing required image fails naming the role', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd09c-'));
    const media = join(root, 'media');
    await fixtureMedia(media, ['cf-logo']);
    await expect(generateChannelBundles(fixtureRelease(root, media), specs, join(root, 'o'))).rejects.toThrow(/logo/);
  });
  it('a wrong-sized image fails instead of being resized silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd09d-'));
    const media = join(root, 'media');
    await fixtureMedia(media, ['itch-cover']);
    await fixtureImage(join(media, 'itch-cover.png'), 600, 500, 'png');
    await expect(generateChannelBundles(fixtureRelease(root, media), specs, join(root, 'o'))).rejects.toThrow(/630x500/);
  });
  it('copy that names a licensed theme fails the lint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd09e-'));
    const media = join(root, 'media');
    await fixtureMedia(media);
    const rel = { ...fixtureRelease(root, media), descriptionOverrides: { curseforge: 'A Hogwarts castle for the game.' } };
    await expect(generateChannelBundles(rel, specs, join(root, 'o'))).rejects.toThrow(/lint/);
  });
  it('a shortener link in final copy fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd09f-'));
    const media = join(root, 'media');
    await fixtureMedia(media);
    const rel = { ...fixtureRelease(root, media), descriptionOverrides: { curseforge: 'Get it at https://bit.ly/abc' } };
    await expect(generateChannelBundles(rel, specs, join(root, 'o'))).rejects.toThrow(/shortener/);
  });
});

describe('release-channels: the specs', () => {
  it('every spec loads and every preset it names exists in the X-14 table', () => {
    const specs = loadChannelSpecs(SPEC_DIR);
    expect(specs.map(s => s.channel)).toEqual(['curseforge', 'itch', 'mcpedl']);
    for (const s of specs) for (const i of s.images) expect(MEDIA_PRESETS.some(p => p.id === i.preset)).toBe(true);
  });
  it('generator sources contain no upload calls', () => {
    const src = readFileSync(join(ROOT, 'web', 'src', 'release', 'channels.ts'), 'utf8');
    for (const banned of ['fetch(', 'butler', 'wrangler', 'api.curseforge', 'itch.io/api', 'git push', 'git tag', 'XMLHttpRequest', 'node:http', 'node:https']) {
      expect(src.includes(banned), banned).toBe(false);
    }
  });
});
