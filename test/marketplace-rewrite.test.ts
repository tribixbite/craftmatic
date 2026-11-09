import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { createZip, extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { minifigCreatorLibrary } from '../web/src/engine/minifig-creator.js';
import {
  CONTENT_FOLDERS, RewriteError, assertNoResidual, findDanglingReferences, rewriteNbtStrings, rewritePack, scanForToken,
  type PackFile,
} from '../web/src/engine/marketplace/rewrite.js';

const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const model = () => { const g = new BlockGrid(6, 3, 4); g.fill(0, 0, 0, 5, 0, 3, 'minecraft:black_concrete'); g.fill(1, 1, 1, 4, 1, 2, 'minecraft:red_concrete'); return g; };
const OPTS = { creator: 'cmt', pack: 'test' } as const;
const text = (f: PackFile): string => new TextDecoder().decode(f.data);

/** Unzip a built add-on into a file list. */
async function filesOf(bytes: Uint8Array): Promise<PackFile[]> {
  const buffer = ab(bytes);
  const out: PackFile[] = [];
  for (const name of listZipEntries(buffer)) if (!name.endsWith('/')) out.push({ name, data: new Uint8Array(await extractFile(buffer, name)) });
  return out;
}

/** The synthetic fixtures of test/playable-addon.test.ts: plain, scenery seat, standalone figure creator. */
async function fixtures(): Promise<Array<[string, PackFile[]]>> {
  const plain = await buildPlayableAddon(model(), { stem: 'Plain' });
  const seat = await buildPlayableAddon(model(), { stem: 'Seat Only', seats: [{ x: 0.5, y: 0.5, z: 0.5, yaw: 0, label: 'Chair' }] });
  const provider = { getPartMesh: async (part: string) => ({ partId: part, resolvedAs: part, description: 'Minifig Torso', triangles: [{ a: [0, 0, 0], b: [20, 0, 0], c: [0, 24, 0], color: 16 }], studs: [], bounds: { min: [0, 0, 0], max: [20, 24, 4] }, unresolvedRefs: [] }), report: () => ({ unresolved: [], printFallbacks: [], substitutions: [] }) };
  const library = minifigCreatorLibrary('starter');
  library.slots.minifig = { torso: [{ part: '973', label: 'Torso', group: 'Core' }], head: [{ part: '3626c', label: 'Head', group: 'Core' }] };
  const creator = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Creator', minifigCreator: library, partGeometry: provider as never });
  return [['plain', await filesOf(plain.bytes)], ['seat', await filesOf(seat.bytes)], ['creator', await filesOf(creator.bytes)]];
}

describe('marketplace-rewrite', () => {
  it('a rewritten pack contains no craftmatic token and every geometry an entity names is defined', async () => {
    for (const [label, files] of await fixtures()) {
      expect(scanForToken(files).length, `${label}: the dev pack has tokens`).toBeGreaterThan(0);
      const { files: out, report } = rewritePack(files, OPTS);
      expect(report.residual, label).toEqual([]);
      expect(() => assertNoResidual(report)).not.toThrow();
      expect(scanForToken(out), label).toEqual([]);
      expect(findDanglingReferences(files), `${label}: dev pack is consistent`).toEqual([]);
      expect(findDanglingReferences(out), label).toEqual([]);
      // the namespace is the product namespace in every entity, block and item id
      const ids = out.filter(f => /\/(entities|blocks|items)\//.test(f.name)).flatMap(f => [...text(f).matchAll(/"identifier"\s*:\s*"([^"]+)"/g)].map(m => m[1]!));
      expect(ids.length, label).toBeGreaterThan(0);
      for (const id of ids) expect(id.startsWith('cmt_test:'), `${label}: ${id}`).toBe(true);
    }
  });

  it('no file sits loose in a content type folder after the rewrite', async () => {
    for (const [label, files] of await fixtures()) {
      const { files: out } = rewritePack(files, OPTS);
      const loose: string[] = [];
      for (const f of out) {
        const rel = f.name.slice(f.name.indexOf('/') + 1);
        const folder = [...CONTENT_FOLDERS].sort((a, b) => b.length - a.length).find(x => rel.startsWith(`${x}/`));
        if (folder && !rel.startsWith(`${folder}/cmt/test/`)) loose.push(f.name);
      }
      expect(loose, label).toEqual([]);
      for (const f of out) expect(['cmt_test_BP', 'cmt_test_RP']).toContain(f.name.split('/')[0]);
    }
  });

  it('the content folder list equals the Python gate list', () => {
    const py = readFileSync('scripts/_mcaddon_check.py', 'utf8');
    const block = /RELEASE_CONTENT_FOLDERS = \(([\s\S]*?)\n\)/.exec(py)![1]!;
    const listed = [...block.matchAll(/'([a-z_/]+)'/g)].map(m => m[1]!);
    expect([...CONTENT_FOLDERS].sort()).toEqual([...listed].sort());
  });

  it('re-addresses structure and function ids with the folder move', async () => {
    const [, files] = (await fixtures())[0]!;
    expect(files.some(f => f.name.includes('/structures/'))).toBe(true);
    const { files: out, report } = rewritePack(files, OPTS);
    expect(report.structureIds.length).toBeGreaterThan(0);
    const script = text(out.find(f => f.name.endsWith('/scripts/placement.js'))!);
    for (const s of report.structureIds) {
      expect(s.from.startsWith('craftmatic:')).toBe(true);
      const tile = s.to.slice('cmt:test/'.length);
      expect(out.some(f => f.name.endsWith(`/structures/cmt/test/${tile}.mcstructure`)), s.to).toBe(true);
      expect(script).toContain(`"${s.to}"`);
    }
    // `/function <alias>` in the README now names the moved function file
    const readme = text(out.find(f => f.name.endsWith('README.txt'))!);
    const refs = [...readme.matchAll(/\/function (\S+)/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const m of refs) expect(m[1]!.startsWith('cmt/test/')).toBe(true);
  });

  it('rewrites a .mcstructure block palette with corrected string lengths', () => {
    const enc = new TextEncoder();
    const str = (s: string): number[] => { const b = enc.encode(s); return [b.length & 255, b.length >> 8, ...b]; };
    const nbt = Uint8Array.from([10, ...str(''), 8, ...str('name'), ...str('craftmatic:collider'), 3, ...str('craftmatic:lo'), 1, 0, 0, 0, 0]);
    const out = rewriteNbtStrings(nbt, s => s.replace('craftmatic', 'cmt_test'));
    const decoded = new TextDecoder().decode(out);
    expect(decoded).toContain('cmt_test:collider');
    expect(decoded).toContain('cmt_test:lo');
    expect(decoded).not.toContain('craftmatic');
    // the length prefix of the first value string (after root header + tag 8 + name) is its new byte count
    expect(out[1 + 2 + 1 + 2 + 4]).toBe('cmt_test:collider'.length);
    expect(() => rewriteNbtStrings(nbt.subarray(0, nbt.length - 2), s => s)).toThrow(RewriteError);
  });

  it('installs frozen uuids, refuses an already rewritten pack and a bad creator', async () => {
    const [, files] = (await fixtures())[0]!;
    const uuids = { bpHeader: '11111111-1111-4111-8111-111111111111', bpData: '22222222-2222-4222-8222-222222222222', bpScript: '33333333-3333-4333-8333-333333333333', rpHeader: '44444444-4444-4444-8444-444444444444', rpResources: '55555555-5555-4555-8555-555555555555' };
    const { files: out } = rewritePack(files, { ...OPTS, uuids });
    const bp = JSON.parse(text(out.find(f => f.name === 'cmt_test_BP/manifest.json')!));
    const rp = JSON.parse(text(out.find(f => f.name === 'cmt_test_RP/manifest.json')!));
    expect(bp.header.uuid).toBe(uuids.bpHeader);
    expect(bp.modules.map((m: { uuid: string }) => m.uuid)).toEqual([uuids.bpData, uuids.bpScript]);
    expect(bp.dependencies[0].uuid).toBe(uuids.rpHeader);
    expect(rp.header.uuid).toBe(uuids.rpHeader);
    expect(rp.modules[0].uuid).toBe(uuids.rpResources);
    expect(() => rewritePack(out, OPTS)).toThrow(RewriteError);
    expect(() => rewritePack(files, { creator: 'craftmatic', pack: 'x' })).toThrow(RewriteError);
    expect(() => rewritePack(files, { creator: 'c_m', pack: 'x' })).toThrow(RewriteError);
  });

  it('is deterministic and leaves the credits file tool name alone', async () => {
    const [, files] = (await fixtures())[0]!;
    const root = files[0]!.name.split('/')[0]!;
    const credits: PackFile = { name: `${root}/CREDITS.txt`, data: new TextEncoder().encode('Made with Craftmatic.') };
    const a = rewritePack([...files, credits], OPTS);
    const b = rewritePack([...files, credits].reverse(), OPTS);
    expect(a.report.residual).toEqual([]);
    expect(a.files.map(f => f.name)).toEqual(b.files.map(f => f.name));
    expect(text(a.files.find(f => f.name.endsWith('CREDITS.txt'))!)).toContain('Craftmatic');
  });

  it('the Python gate finds no namespace or folder error in a rewritten pack', async () => {
    const [, files] = (await fixtures())[1]!;
    const { files: out } = rewritePack(files, OPTS);
    mkdirSync('output/x03', { recursive: true });
    writeFileSync('output/x03/fixture-rewritten.mcaddon', await createZip(out, { alwaysDeflate: true }));
    const run = spawnSync('python', ['-I', 'scripts/_mcaddon_check.py', '--release', 'output/x03/fixture-rewritten.mcaddon'], { encoding: 'utf8' });
    const output = `${run.stdout}${run.stderr}`;
    // only the namespace and folder rules are this pass's; pack_scope, the RP dependency and vanilla texture
    // paths belong to X-02 and M03 and are expected to still fail here.
    expect(output).not.toMatch(/!! \[release\].*(namespace|not under <type>|different <creator>\/<pack>)/);
    expect(output).toContain("namespace 'cmt_test'");
    expect(output).not.toMatch(/Traceback/);
  });
});
