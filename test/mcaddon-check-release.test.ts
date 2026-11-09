/**
 * `scripts/_mcaddon_check.py --release` (X-06, BIZ-24 / BIZ-54): the sell-side rules on top of the dev gate.
 *
 * Fixtures are built here by `buildPack()` (deterministic bytes: fixed mtimes, fixed deflate level) and the four
 * small zips are committed under test/fixtures/mcaddon/. A test fails when a committed zip drifts from the
 * builder; `UPDATE_FIXTURES=1 bunx vitest run test/mcaddon-check-release.test.ts` rewrites them.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipSync, zlibSync } from 'fflate';

const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', '_mcaddon_check.py');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'mcaddon');
const TMP = mkdtempSync(join(tmpdir(), 'mcaddon-release-'));

type Files = Record<string, string | Uint8Array>;

/** A real, valid PNG of `w` x `h` (opaque grey), small enough to commit even at 2049 px wide. */
function png(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const row = new Uint8Array(1 + w).fill(128);
  row[0] = 0;
  const raw = new Uint8Array(row.length * h);
  for (let y = 0; y < h; y++) raw.set(row, y * row.length);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

const BP = 'Acme_Demo_BP/';
const RP = 'Acme_Demo_RP/';
const BP_UUID = '11111111-2222-4333-8444-555555555555';
const RP_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';

/** A block with `states` state lists of the given sizes: registered permutations = their product. */
function blockJson(id: string, sizes: number[], format = '1.21.30'): string {
  const states: Record<string, number[]> = {};
  sizes.forEach((n, i) => (states[`acme:s${i}`] = Array.from({ length: n }, (_, k) => k)));
  return JSON.stringify({
    format_version: format,
    'minecraft:block': { description: { identifier: id, states }, components: {} },
  });
}

/** The smallest pack that satisfies every release rule AND the dev gate. */
function releaseOkFiles(): Files {
  return {
    [`${BP}manifest.json`]: JSON.stringify({
      format_version: 2,
      header: { name: 'Demo', description: 'Demo', uuid: BP_UUID, version: [1, 0, 0], min_engine_version: [1, 26, 0] },
      modules: [{ type: 'data', uuid: '0b0b0b0b-0000-4000-8000-000000000001', version: [1, 0, 0] }],
      dependencies: [{ uuid: RP_UUID, version: [1, 0, 0] }],
    }),
    [`${RP}manifest.json`]: JSON.stringify({
      format_version: 2,
      header: {
        name: 'Demo RP',
        description: 'Demo',
        uuid: RP_UUID,
        version: [1, 0, 0],
        min_engine_version: [1, 26, 0],
        pack_scope: 'world',
      },
      modules: [{ type: 'resources', uuid: '0c0c0c0c-0000-4000-8000-000000000002', version: [1, 0, 0] }],
      dependencies: [{ uuid: BP_UUID, version: [1, 0, 0] }],
    }),
    [`${BP}entities/acme/demo/thing.json`]: JSON.stringify({
      format_version: '1.21.0',
      'minecraft:entity': { description: { identifier: 'acme:thing', is_spawnable: true }, components: {} },
    }),
    [`${BP}blocks/acme/demo/slab.json`]: blockJson('acme:slab', [4, 2]),
    [`${BP}items/acme/demo/wand.json`]: JSON.stringify({
      format_version: '1.21.30',
      'minecraft:item': { description: { identifier: 'acme:wand' }, components: {} },
    }),
    [`${RP}entity/acme/demo/thing.entity.json`]: JSON.stringify({
      format_version: '1.10.0',
      'minecraft:client_entity': {
        description: {
          identifier: 'acme:thing',
          materials: { default: 'entity' },
          textures: { default: 'textures/entity/acme/demo/thing' },
          geometry: { default: 'geometry.acme.thing' },
          render_controllers: ['controller.render.acme.thing'],
        },
      },
    }),
    [`${RP}models/entity/acme/demo/thing.geo.json`]: JSON.stringify({
      format_version: '1.12.0',
      'minecraft:geometry': [{ description: { identifier: 'geometry.acme.thing' }, bones: [] }],
    }),
    [`${RP}animations/acme/demo/thing.animation.json`]: JSON.stringify({
      format_version: '1.8.0',
      animations: { 'animation.acme.thing.spin': { loop: true } },
    }),
    [`${RP}render_controllers/acme/demo/thing.render_controllers.json`]: JSON.stringify({
      format_version: '1.8.0',
      render_controllers: { 'controller.render.acme.thing': { geometry: 'Geometry.default' } },
    }),
    [`${RP}textures/entity/acme/demo/thing.png`]: png(64, 64),
    [`${RP}textures/blocks/acme/demo/slab.png`]: png(16, 16),
    [`${RP}pack_icon.png`]: png(256, 256),
    [`${RP}texts/en_US.lang`]: 'tile.acme:slab.name=Slab\n',
    [`${RP}sounds.json`]: JSON.stringify({
      interactive_sounds: {
        block_sounds: { normal: { events: { default: '', fall: '', jump: '', land: '', step: '', fly: '' } } },
      },
    }),
  };
}

/** Deterministic zip: fixed mtime, fixed level, sorted entries. */
function zipOf(files: Files): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  for (const name of Object.keys(files).sort()) {
    const v = files[name];
    entries[name] = [typeof v === 'string' ? new TextEncoder().encode(v) : v, { mtime: new Date(Date.UTC(2026, 0, 1)), level: 6 }];
  }
  return zipSync(entries);
}

const fixtureBuilders: Record<string, () => Files> = {
  'release-ok': releaseOkFiles,
  'no-scope': () => {
    const f = releaseOkFiles();
    const m = JSON.parse(f[`${RP}manifest.json`] as string);
    delete m.header.pack_scope;
    f[`${RP}manifest.json`] = JSON.stringify(m);
    return f;
  },
  'vanilla-tex': () => ({
    ...releaseOkFiles(),
    [`${RP}textures/blocks/concrete_white.png`]: png(16, 16),
  }),
  // 10,000 + 1 registered permutations (10 x 10 x 10 x 10 and a stateless block): one over the release cap.
  'many-perms': () => ({
    ...releaseOkFiles(),
    [`${BP}blocks/acme/demo/slab.json`]: blockJson('acme:slab', [10, 10, 10, 10]),
    [`${BP}blocks/acme/demo/post.json`]: blockJson('acme:post', []),
  }),
};

if (process.env.UPDATE_FIXTURES) {
  mkdirSync(FIXTURES, { recursive: true });
  for (const [name, build] of Object.entries(fixtureBuilders)) writeFileSync(join(FIXTURES, `${name}.zip`), zipOf(build()));
}

/** Write a variant to the scratch dir (a NEW name each call) and return its path. */
let counter = 0;
function variant(files: Files, ext = 'mcaddon'): string {
  const p = join(TMP, `v${counter++}.${ext}`);
  writeFileSync(p, zipOf(files));
  return p;
}

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync('python', ['-I', SCRIPT, ...args], { encoding: 'utf-8', cwd: ROOT });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const fixture = (name: string): string => join(FIXTURES, `${name}.zip`);

describe('mcaddon-check-release', () => {
  it('a pack without pack_scope world fails --release', () => {
    const r = run(['--release', fixture('no-scope')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/pack_scope is None/);
    // the dev gate alone does not look at pack_scope
    expect(run([fixture('no-scope')]).code).toBe(0);
  });

  it('10,001 permutations fail --release while 65,536 still passes the dev mode', () => {
    const r = run(['--release', fixture('many-perms')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/10001 registered block permutations/);
    expect(run([fixture('many-perms')]).code).toBe(0);
    // exactly 10,000 is allowed; 16^4 = 65,536 is the dev ceiling and still passes there.
    const atCap = releaseOkFiles();
    atCap[`${BP}blocks/acme/demo/slab.json`] = blockJson('acme:slab', [10, 10, 10, 10]);
    expect(run(['--release', variant(atCap)]).code).toBe(0);
    const devMax = releaseOkFiles();
    devMax[`${BP}blocks/acme/demo/slab.json`] = blockJson('acme:slab', [16, 16, 16, 16]);
    const devPath = variant(devMax);
    expect(run([devPath]).code).toBe(0);
    expect(run(['--release', devPath]).out).toMatch(/65536 registered block permutations/);
  });

  it('a craftmatic: id fails --release', () => {
    const f = releaseOkFiles();
    f[`${BP}items/acme/demo/wand.json`] = (f[`${BP}items/acme/demo/wand.json`] as string).replace('acme:wand', 'craftmatic:wand');
    const r = run(['--release', variant(f)]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/namespace 'craftmatic' is the development namespace/);
    expect(r.out).toMatch(/more than one namespace/);
  });

  it('a minecraft: definition fails --release', () => {
    const f = releaseOkFiles();
    f[`${BP}items/acme/demo/wand.json`] = (f[`${BP}items/acme/demo/wand.json`] as string).replace('acme:wand', 'minecraft:stick');
    expect(run(['--release', variant(f)]).out).toMatch(/define minecraft: ids/);
  });

  it('a texture at a vanilla path fails --release', () => {
    const r = run(['--release', fixture('vanilla-tex')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/vanilla texture path: textures\/blocks\/concrete_white\.png/);
  });

  it('a rule-built fixture passes --release', () => {
    const r = run(['--release', fixture('release-ok')]);
    expect(r.out).toMatch(/^OK /m);
    expect(r.code).toBe(0);
    expect(run(['--marketplace', fixture('release-ok')]).code).toBe(0);
  });

  it('loose files in content-type folders fail --release', () => {
    const f = releaseOkFiles();
    f[`${BP}entities/loose.json`] = f[`${BP}entities/acme/demo/thing.json`];
    f[`${BP}functions/go.mcfunction`] = 'say hi';
    const r = run(['--release', variant(f)]);
    expect(r.out).toMatch(/2 file\(s\) not under <type>\/<creator>\/<pack>\//);
  });

  it('oversize block and entity textures fail --release', () => {
    const f = releaseOkFiles();
    f[`${RP}textures/blocks/acme/demo/slab.png`] = png(257, 1);
    f[`${RP}textures/entity/acme/demo/thing.png`] = png(2049, 1);
    const r = run(['--release', variant(f)]);
    expect(r.out).toMatch(/2 texture\(s\) over the size limit/);
    const ok = releaseOkFiles();
    ok[`${RP}textures/blocks/acme/demo/slab.png`] = png(256, 256);
    ok[`${RP}textures/entity/acme/demo/thing.png`] = png(2048, 1);
    expect(run(['--release', variant(ok)]).code).toBe(0);
  });

  it('a -beta script module, a diagnostics file and a download link fail --release', () => {
    const f = releaseOkFiles();
    const m = JSON.parse(f[`${BP}manifest.json`] as string);
    m.dependencies.push({ module_name: '@minecraft/server', version: '2.0.0-beta' });
    f[`${BP}manifest.json`] = JSON.stringify(m);
    f[`${BP}craftmatic-diagnostics.json`] = '{}';
    f[`${BP}README.txt`] = 'Get more at https://www.mediafire.com/file/abc\n';
    const r = run(['--release', variant(f)]);
    expect(r.out).toMatch(/beta script module/);
    expect(r.out).toMatch(/dev diagnostics shipped/);
    expect(r.out).toMatch(/external download link/);
  });

  it('a resource pack that does not depend on the behaviour pack fails --release', () => {
    const f = releaseOkFiles();
    const m = JSON.parse(f[`${RP}manifest.json`] as string);
    m.dependencies = [];
    f[`${RP}manifest.json`] = JSON.stringify(m);
    expect(run(['--release', variant(f)]).out).toMatch(/resource pack does not depend on the behaviour pack/);
  });

  it('size and file count caps fail --release', () => {
    const big = releaseOkFiles();
    big[`${BP}structures/acme/demo/big.mcstructure`] = new Uint8Array(26 * 1024 * 1024);
    expect(run(['--release', variant(big)]).out).toMatch(/MiB uncompressed/);
    const many = releaseOkFiles();
    for (let i = 0; i < 3500; i++) many[`${BP}functions/acme/demo/f${i}.mcfunction`] = 'say';
    expect(run(['--release', variant(many)]).out).toMatch(/files \(a release allows 3,500\)/);
  });

  it('a .zip wrapped in one root folder fails --release', () => {
    const wrapped: Files = {};
    for (const [k, v] of Object.entries(releaseOkFiles())) wrapped[`Pack/${k}`] = v;
    const r = run(['--release', variant(wrapped, 'zip')]);
    expect(r.out).toMatch(/wrapped in one root folder 'Pack'/);
    expect(run(['--release', variant(releaseOkFiles(), 'zip')]).code).toBe(0);
  });

  it('the committed fixture zips match the builder', () => {
    for (const [name, build] of Object.entries(fixtureBuilders)) {
      const path = fixture(name);
      expect(existsSync(path), `${name}.zip is missing: run with UPDATE_FIXTURES=1`).toBe(true);
      expect(Buffer.compare(readFileSync(path), Buffer.from(zipOf(build()))), `${name}.zip drifted`).toBe(0);
    }
  });

  it('a pack without --release is checked exactly as before', () => {
    const r = run([fixture('vanilla-tex')]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/\[release\]/);
    expect(r.out).toMatch(/1\/1 packs structurally valid\s*$/);
  });
});
