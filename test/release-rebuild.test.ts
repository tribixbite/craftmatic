/**
 * The pure parts of `release.ts finalize | verify | status` and the release profile (D-08b, BIZ-51 / BIZ-56).
 * The end-to-end runs (a real rebuild from a tag) are in `release-script.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createZip } from '../web/src/engine/zip-utils.js';
import { RELEASE_PROFILE_FLAGS, pinProblems, PENDING_STAGES } from '../web/src/release/prepare.js';
import {
  compareArtifacts, ledgerEntryFor, packIds, releaseTag, releaseStatus, renderStatus, tagProblems,
} from '../web/src/release/prepare-rebuild.js';
import { loadReleaseModel, modelProblems } from '../web/src/release/prepare-model.js';
import { checkLedgerAppend } from '../web/src/release/identity-ledger.js';
import type { ProductRecord } from '../web/src/release/types.js';

const A = { file: 'dist/p-1.0.0.mcaddon', sha256: 'a'.repeat(64), bytes: 10 };
const B = { file: 'dist/p-1.0.0.zip', sha256: 'b'.repeat(64), bytes: 10 };
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('release-rebuild: the profile', () => {
  it('a release profile turns on the brick blocks, the compact collider states and the marketplace placement', () => {
    expect(RELEASE_PROFILE_FLAGS).toMatchObject({
      brickBlocks: true, compactColliderStates: true, marketplacePlacement: true,
      vanillaTextures: false, diagnostics: false, faceArt: false, devStamp: false, explicitOnly: true,
    });
  });

  it('M03 and M07 are no longer pending stages', () => {
    expect(PENDING_STAGES.filter(s => ['M03', 'M07'].includes(s.dependency))).toEqual([]);
  });
});

describe('release-rebuild: compareArtifacts', () => {
  it('equal sets give no problem, whatever the order', () => {
    expect(compareArtifacts([A, B], [B, A])).toEqual([]);
  });

  it('refuses one byte of difference and names both hashes', () => {
    const flipped = { ...A, sha256: `${'a'.repeat(63)}b` };
    const problems = compareArtifacts([A, B], [flipped, B]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(A.file);
    expect(problems[0]).toContain(A.sha256);
    expect(problems[0]).toContain(flipped.sha256);
  });

  it('refuses a missing and an extra artifact', () => {
    expect(compareArtifacts([A, B], [A]).join(' ')).toMatch(/missing from the rebuild: dist\/p-1\.0\.0\.zip/);
    expect(compareArtifacts([A], [A, B]).join(' ')).toMatch(/not in the prepared release: dist\/p-1\.0\.0\.zip/);
  });
});

describe('release-rebuild: tags', () => {
  it('the tag is <product>-v<semver>', () => {
    expect(releaseTag('sampler', { major: 1, minor: 2, patch: 3 })).toBe('sampler-v1.2.3');
  });

  it('refuses a missing tag and a tag on another commit than the prepared one', () => {
    expect(tagProblems('sampler-v1.0.0', null, 'abc')[0]).toMatch(/does not exist.*you create it/i);
    expect(tagProblems('sampler-v1.0.0', 'def', 'abc')[0]).toMatch(/points at def.*prepared from abc/);
    expect(tagProblems('sampler-v1.0.0', 'abc', 'abc')).toEqual([]);
  });
});

describe('release-rebuild: the ledger entry', () => {
  const product = {
    id: 'p', identity: {
      namespace: 'tst_p', folderStem: 'P',
      uuids: { bpHeader: 'u1', bpData: 'u2', bpScript: 'u3', rpHeader: 'u4', rpResources: 'u5' },
    },
  } as unknown as ProductRecord;

  it('packIds reads entity, block and item identifiers from the behaviour pack', () => {
    const j = (key: string, id: string): Uint8Array => enc(JSON.stringify({ [key]: { description: { identifier: id } } }));
    const ids = packIds([
      { name: 'P_BP/entities/tst/p/a.json', data: j('minecraft:entity', 'tst_p:a') },
      { name: 'P_BP/blocks/tst/p/brick.json', data: j('minecraft:block', 'tst_p:brick_white') },
      { name: 'P_BP/items/tst/p/wand.json', data: j('minecraft:item', 'tst_p:wand') },
      { name: 'P_RP/entity/tst/p/a.entity.json', data: j('minecraft:client_entity', 'tst_p:a') },
    ]);
    expect(ids).toEqual({ entityIds: ['tst_p:a'], blockIds: ['tst_p:brick_white'], itemIds: ['tst_p:wand'] });
  });

  it('builds an entry the ledger accepts, keyed by the artifact file names', () => {
    const entry = ledgerEntryFor(product, '1.0.0', { entityIds: ['tst_p:a'], blockIds: [], itemIds: [] }, [A, B]);
    expect(entry.sha256).toEqual({ 'p-1.0.0.mcaddon': A.sha256, 'p-1.0.0.zip': B.sha256 });
    expect(checkLedgerAppend([], entry, product)).toEqual([]);
  });
});

describe('release-rebuild: status', () => {
  const folders = [
    { product: 'p', version: '1.0.0', release: { version: { major: 1, minor: 0, patch: 0 }, commit: 'c1', tag: null, sourceDateEpoch: 1, artifacts: [A], deviceEvidence: null }, finalize: { tag: 'p-v1.0.0', tagCommit: 'c1', deviceEvidence: 'round-9' } },
    { product: 'p', version: '1.1.0', release: { version: { major: 1, minor: 1, patch: 0 }, commit: 'c2', tag: null, sourceDateEpoch: 2, artifacts: [A], deviceEvidence: null } },
  ];
  const ledger = [{ product: 'p', version: '1.0.0', namespace: 'x', uuids: {}, entityIds: [], blockIds: [], itemIds: [], sha256: {} }] as never;

  it('lists each version as prepared, finalized and released', () => {
    const rows = releaseStatus(['p', 'q'], ledger, folders);
    expect(rows.find(r => r.product === 'q')?.versions).toEqual([]);
    const versions = rows.find(r => r.product === 'p')!.versions;
    expect(versions.map(v => [v.version, v.prepared, v.finalized, v.released])).toEqual([
      ['1.0.0', true, true, true],
      ['1.1.0', true, false, false],
    ]);
    expect(versions[0]).toMatchObject({ tag: 'p-v1.0.0', deviceEvidence: 'round-9' });
  });

  it('a version only the ledger knows is released but not prepared here', () => {
    const rows = releaseStatus(['p'], ledger, []);
    expect(rows[0]!.versions.map(v => [v.version, v.prepared, v.released])).toEqual([['1.0.0', false, true]]);
  });

  it('renders one line per version and says so when a product has none', () => {
    const text = renderStatus(releaseStatus(['p', 'q'], ledger, folders));
    expect(text).toMatch(/^p 1\.0\.0\s+prepared\s+finalized\s+released/m);
    expect(text).toMatch(/^p 1\.1\.0\s+prepared\s+-\s+-/m);
    expect(text).toMatch(/^q\s+no version prepared or released/m);
  });
});

describe('release-rebuild: pins', () => {
  it('pinProblems names a wrong bun, lockfile and LDraw archive, and ignores tree state and version', () => {
    const product = { id: 'p', toolchain: { bun: '1.3.11', lockfileSha256: 'x', ldrawLibrary: { archive: 'complete.zip', sha256: 'y', root: '' } } } as unknown as ProductRecord;
    const out = pinProblems(product, { bunVersion: '1.0.0', lockfileSha256: 'z', ldrawArchiveSha256: null });
    expect(out.join('\n')).toMatch(/bun is 1\.0\.0/);
    expect(out.join('\n')).toMatch(/bun\.lock sha256/);
    expect(out.join('\n')).toMatch(/archive not found/);
    expect(pinProblems(product, { bunVersion: '1.3.11', lockfileSha256: 'x', ldrawArchiveSha256: 'y' })).toEqual([]);
  });
});

/* -- model inputs through the B01 import service ---------------------------------------------------------- */

const SCRATCH = resolve(__dirname, '..', 'output', 'release-rebuild-test');
const fresh = (name: string): string => {
  const dir = join(SCRATCH, `${Date.now()}-${randomBytes(3).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
};
const PUBLIC = resolve(__dirname, '..', 'web', 'public');
const COTTAGE = readFileSync(resolve(__dirname, 'fixtures', 'release', 'root', 'models', 'fixture-cottage.ldr'), 'utf8');
const BONE = '1,0,0,0,1,0,0,0,1';
const LXFML = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n<LXFML versionMajor="5" versionMinor="0" name="t"><Bricks>'
  + `<Brick refID="0" designID="3001"><Part refID="0" designID="3001" materials="21,0"><Bone refID="0" transformation="${BONE},0,0,0"/></Part></Brick>`
  + `<Brick refID="1" designID="3020"><Part refID="1" designID="3020" materials="24,0"><Bone refID="1" transformation="${BONE},0,1,0"/></Part></Brick>`
  + '</Bricks></LXFML>';

describe('release-rebuild: model inputs', () => {
  it('reads an .ldr as before', async () => {
    const m = await loadReleaseModel(resolve(__dirname, 'fixtures', 'release', 'root', 'models', 'fixture-cottage.ldr'), PUBLIC);
    expect(m.format).toBe('ldr');
    expect(m.bricks.length).toBe(COTTAGE.split('\n').filter(l => l.startsWith('1 ')).length);
    expect(m.colorSpace).toBe('ldraw');
  });

  it('reads a zipped .lxf through the import service (a DOM-free reader with the shipped tables)', async () => {
    const file = fresh('two-bricks.lxf');
    writeFileSync(file, await createZip([{ name: 'IMAGE100.LXFML', data: enc(LXFML) }]));
    const m = await loadReleaseModel(file, PUBLIC);
    expect(m.format).toBe('lxf');
    expect(m.bricks.map(b => b.part)).toEqual(['3001.dat', '3020.dat']);
    expect(modelProblems(m)).toEqual([]);
  });

  it('reads an .io, keeps the Studio colour space and hands its CustomParts to the library seed', async () => {
    const file = fresh('studio.io');
    writeFileSync(file, await createZip([
      { name: 'model2.ldr', data: enc('0 Test\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n') },
      { name: 'CustomParts/parts/99999.dat', data: enc('0 custom\n') },
    ]));
    const m = await loadReleaseModel(file, PUBLIC);
    expect(m.format).toBe('io');
    expect(m.colorSpace).toBe('bl');
    expect(m.embeddedParts.map(([name]) => name)).toContain('parts/99999.dat');
  });

  it('an .io of a plain model.ldr is the same bricks as the .ldr', async () => {
    const file = fresh('cottage.io');
    writeFileSync(file, await createZip([{ name: 'model.ldr', data: enc(COTTAGE) }]));
    const io = await loadReleaseModel(file, PUBLIC);
    const ldr = await loadReleaseModel(resolve(__dirname, 'fixtures', 'release', 'root', 'models', 'fixture-cottage.ldr'), PUBLIC);
    expect(io.colorSpace).toBe('ldraw');
    expect(io.bricks).toEqual(ldr.bricks);
  });

  it('refuses an unaligned conversion and an empty model', async () => {
    const file = fresh('broken.ldr');
    writeFileSync(file, '0 x\n0 Author: convert_lxf.py\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n');
    const m = await loadReleaseModel(file, PUBLIC);
    expect(modelProblems(m).join(' ')).toMatch(/unaligned/i);
    const empty = fresh('empty.ldr');
    writeFileSync(empty, '0 nothing here\n');
    expect(modelProblems(await loadReleaseModel(empty, PUBLIC)).join(' ')).toMatch(/no bricks/i);
  });

  it('refuses a file type it cannot read', async () => {
    const file = fresh('model.stl');
    writeFileSync(file, 'solid x');
    await expect(loadReleaseModel(file, PUBLIC)).rejects.toThrow(/\.ldr, \.mpd, \.io, \.lxf, \.lxfml or \.zip/);
    expect(existsSync(file)).toBe(true);
  });
});
