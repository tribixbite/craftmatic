/**
 * `web/src/engine/byom/pack-check.ts` (X-07, BIZ-24 / BIZ-38): the TypeScript port of
 * `scripts/_mcaddon_check.py`, dev rules and `--release` rules.
 *
 * PARITY is the whole point: every archive here is checked by BOTH implementations (the Python script is spawned
 * as `python -I -X utf8 scripts/_mcaddon_check.py [--release] <file>` and its report parsed) and the verdicts must
 * be identical: ok/fail, the problem list line for line, and the notes. Archives are
 *   - the committed fixture zips (test/fixtures/mcaddon/),
 *   - archives built here that trip each rule the fixtures do not (every dev rule; the remaining release rules),
 *   - real built packs from `output/x02-compare/main/` (local-only: gated on existence at module load), and one of
 *     them rewritten by `scripts/_marketplace_pack.ts`.
 *
 * Only a Python `1.0` versus a JavaScript `1` can differ in a message (JSON cannot tell them apart once parsed in
 * JS); `normalise` folds `N.0` to `N` on both sides. Everything else is compared byte for byte.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipSync, zlibSync } from 'fflate';
import { checkPack, fixed1, pyRepr } from '../web/src/engine/byom/pack-check.ts';

const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', '_mcaddon_check.py');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'mcaddon');
const BUILT_DIR = 'C:/git/craftmatic/output/x02-compare/main';
// Gated at module load (a skipped `describe` still runs its body, so nothing is read there).
const BUILT_PACKS = existsSync(BUILT_DIR) ? readdirSync(BUILT_DIR).filter((f) => f.endsWith('.mcaddon')).sort() : [];
const TMP = mkdtempSync(join(tmpdir(), 'pack-check-'));

type Files = Record<string, string | Uint8Array>;

// ---------------------------------------------------------------------------------------------------------------
// Running both implementations
// ---------------------------------------------------------------------------------------------------------------

interface Verdict {
  ok: boolean;
  unreadable: boolean;
  problems: string[];
  notes: string;
}

const normalise = (s: string): string => s.replace(/(\d)\.0\b/g, '$1');

function runPython(file: string, release: boolean): Verdict {
  // CI's ubuntu runner has `python3` only; Windows has `python`. `PYTHON` overrides both.
  const py = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const args = ['-I', '-X', 'utf8', SCRIPT, ...(release ? ['--release'] : []), file];
  const r = spawnSync(py, args, { encoding: 'utf-8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const lines = r.stdout.split(/\r?\n/);
  const head = lines[0];
  // `f'{status} {name:28s} {notes}'`: the name is padded to 28 columns, never truncated.
  const notes = head.slice(4 + 1 + Math.max(28, basename(file).length) + 1);
  const problems: string[] = [];
  for (const ln of lines.slice(1)) {
    if (!ln.startsWith('       !! ')) break;
    problems.push(ln.slice(10));
  }
  return { ok: head.startsWith('OK  '), unreadable: notes.startsWith('unreadable: '), problems, notes };
}

function runTs(file: string, release: boolean): Verdict {
  const r = checkPack(new Uint8Array(readFileSync(file)), { release, fileName: basename(file) });
  return { ok: r.ok, unreadable: r.error !== undefined, problems: r.problems, notes: r.notes.join('; ') };
}

/** Both verdicts for one archive, in dev mode and in release mode. */
function expectParity(file: string): { dev: Verdict; release: Verdict } {
  const out = {} as { dev: Verdict; release: Verdict };
  for (const release of [false, true]) {
    const py = runPython(file, release);
    const ts = runTs(file, release);
    const label = `${basename(file)} ${release ? '--release' : 'dev'}`;
    expect(ts.unreadable, `${label}: unreadable`).toBe(py.unreadable);
    if (!py.unreadable) {
      expect(ts.ok, `${label}: ok`).toBe(py.ok);
      expect(ts.problems.map(normalise), `${label}: problems`).toEqual(py.problems.map(normalise));
      expect(normalise(ts.notes), `${label}: notes`).toBe(normalise(py.notes));
    }
    out[release ? 'release' : 'dev'] = ts;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Archive builders
// ---------------------------------------------------------------------------------------------------------------

/** A real, valid PNG of `w` x `h` (opaque grey). */
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
  ihdr.set([8, 0, 0, 0, 0], 8);
  const raw = new Uint8Array((1 + w) * h);
  for (let y = 0; y < h; y++) raw.fill(128, y * (1 + w) + 1, (y + 1) * (1 + w));
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

/** An uncompressed true-colour TGA header (18 bytes) declaring `w` x `h`, no pixel data (only the head is read). */
function tga(w: number, h: number): Uint8Array {
  const out = new Uint8Array(32);
  out[2] = 2;
  new DataView(out.buffer).setUint16(12, w, true);
  new DataView(out.buffer).setUint16(14, h, true);
  return out;
}

const BP = 'Acme_Demo_BP/';
const RP = 'Acme_Demo_RP/';
const BP_UUID = '11111111-2222-4333-8444-555555555555';
const RP_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const FLY_OK = { interactive_sounds: { block_sounds: { normal: { events: { default: '', fall: '', jump: '', land: '', step: '', fly: '' } } } } };

const json = (v: unknown): string => JSON.stringify(v);

function blockJson(id: string, states: Record<string, unknown>, extra: Record<string, unknown> = {}, format = '1.21.30'): string {
  return json({ format_version: format, 'minecraft:block': { description: { identifier: id, states }, components: {}, ...extra } });
}

/** A pack that satisfies every dev rule and every release rule: each test edits a copy. */
function baseFiles(): Files {
  return {
    [`${BP}manifest.json`]: json({
      format_version: 2,
      header: { name: 'Demo', description: 'Demo', uuid: BP_UUID, version: [1, 0, 0], min_engine_version: [1, 26, 0] },
      modules: [{ type: 'data', uuid: '0b0b0b0b-0000-4000-8000-000000000001', version: [1, 0, 0] }],
      dependencies: [{ uuid: RP_UUID, version: [1, 0, 0] }],
    }),
    [`${RP}manifest.json`]: json({
      format_version: 2,
      header: { name: 'Demo RP', description: 'Demo', uuid: RP_UUID, version: [1, 0, 0], min_engine_version: [1, 26, 0], pack_scope: 'world' },
      modules: [{ type: 'resources', uuid: '0c0c0c0c-0000-4000-8000-000000000002', version: [1, 0, 0] }],
      dependencies: [{ uuid: BP_UUID, version: [1, 0, 0] }],
    }),
    [`${BP}entities/acme/demo/thing.json`]: json({
      format_version: '1.21.0',
      'minecraft:entity': { description: { identifier: 'acme:thing', is_spawnable: true }, components: {} },
    }),
    [`${BP}blocks/acme/demo/slab.json`]: blockJson('acme:slab', { 'acme:s0': [0, 1, 2, 3], 'acme:s1': [0, 1] }),
    [`${BP}items/acme/demo/wand.json`]: json({ format_version: '1.21.30', 'minecraft:item': { description: { identifier: 'acme:wand' }, components: {} } }),
    [`${RP}entity/acme/demo/thing.entity.json`]: json({
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
    [`${RP}models/entity/acme/demo/thing.geo.json`]: json({
      format_version: '1.12.0',
      'minecraft:geometry': [{ description: { identifier: 'geometry.acme.thing' }, bones: [] }],
    }),
    [`${RP}animations/acme/demo/thing.animation.json`]: json({ format_version: '1.8.0', animations: { 'animation.acme.thing.spin': { loop: true } } }),
    [`${RP}render_controllers/acme/demo/thing.render_controllers.json`]: json({
      format_version: '1.8.0',
      render_controllers: { 'controller.render.acme.thing': { geometry: 'Geometry.default' } },
    }),
    [`${RP}textures/entity/acme/demo/thing.png`]: png(64, 64),
    [`${RP}textures/blocks/acme/demo/slab.png`]: png(16, 16),
    [`${RP}pack_icon.png`]: png(256, 256),
    [`${RP}texts/en_US.lang`]: 'tile.acme:slab.name=Slab\n',
    [`${RP}sounds.json`]: json(FLY_OK),
  };
}

const LOCAL_MTIME = new Date(2026, 0, 1, 12, 0, 0);

function zipOf(files: Files): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  for (const name of Object.keys(files)) {
    const v = files[name];
    entries[name] = [typeof v === 'string' ? new TextEncoder().encode(v) : v, { mtime: LOCAL_MTIME, level: 6 }];
  }
  return zipSync(entries);
}

let counter = 0;
/** Write an archive to the scratch dir under a NEW name each call and return its path. */
function variant(files: Files | Uint8Array, ext = 'mcaddon'): string {
  const p = join(TMP, `v${counter++}.${ext}`);
  writeFileSync(p, files instanceof Uint8Array ? files : zipOf(files));
  return p;
}

/** `base` with `edit` applied. */
function edited(edit: (f: Files) => void): Files {
  const f = baseFiles();
  edit(f);
  return f;
}

/** Edit one JSON file of the base pack in place. */
function patchJson(f: Files, name: string, edit: (d: any) => void): void {
  const d = JSON.parse(f[name] as string);
  edit(d);
  f[name] = json(d);
}

const ENTITY = `${BP}entities/acme/demo/thing.json`;
const BLOCK = `${BP}blocks/acme/demo/slab.json`;

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('byom-pack-check', () => {
  it('pack-check agrees with _mcaddon_check.py on every committed fixture zip, dev and --release', () => {
    const zips = readdirSync(FIXTURES).filter((f) => f.endsWith('.zip'));
    expect(zips.length).toBeGreaterThanOrEqual(4);
    for (const z of zips) expectParity(join(FIXTURES, z));
  });

  it('the base pack passes both rule sets and the fixtures keep their known verdicts', () => {
    const { dev, release } = expectParity(variant(baseFiles()));
    expect(dev.problems).toEqual([]);
    expect(release.problems).toEqual([]);
    const noScope = expectParity(join(FIXTURES, 'no-scope.zip'));
    expect(noScope.dev.ok).toBe(true);
    expect(noScope.release.problems.join('\n')).toContain('header.pack_scope is None');
    const many = expectParity(join(FIXTURES, 'many-perms.zip'));
    expect(many.release.problems.join('\n')).toContain('10001 registered block permutations (a release allows 10,000)');
  });

  describe('dev rules (each tripped on its own, then all at once)', () => {
    const cases: Array<[string, (f: Files) => void, string]> = [
      ['a bad header uuid and a non-list version', (f) => patchJson(f, `${BP}manifest.json`, (d) => { d.header.uuid = 'nope'; d.header.version = '1.0.0'; }), 'bad header uuid'],
      ['a non-string uuid reprs like Python', (f) => patchJson(f, `${BP}manifest.json`, (d) => { d.header.uuid = null; d.modules[0].uuid = 5; }), 'bad header uuid None'],
      ['a third manifest', (f) => { f[`${BP}extra/manifest.json`] = f[`${BP}manifest.json`]; }, 'expected 2 manifests'],
      ['the behaviour pack not depending on the resource pack', (f) => patchJson(f, `${BP}manifest.json`, (d) => { d.dependencies = []; }), 'does not depend'],
      ['texture sets without the pbr capability and with a missing image', (f) => {
        f[`${RP}textures/entity/acme/demo/thing.texture_set.json`] = json({ 'minecraft:texture_set': { color: 'thing', normal: 'thing_n', heightmap: [1, 2, 3], metalness_emissive_roughness: [0, 0, 255] } });
      }, 'texture sets but no pbr capability'],
      ['texture sets with the capability and complete images', (f) => {
        patchJson(f, `${RP}manifest.json`, (d) => { d.capabilities = ['pbr']; });
        f[`${RP}textures/entity/acme/demo/thing.texture_set.json`] = json({ 'minecraft:texture_set': { color: 'thing', normal: 'thing_n' } });
        f[`${RP}textures/entity/acme/demo/thing_n.tga`] = tga(8, 8);
      }, 'PBR texture sets'],
      ['a script module whose entry is missing', (f) => patchJson(f, `${BP}manifest.json`, (d) => { d.modules.push({ type: 'script', uuid: '0d0d0d0d-0000-4000-8000-000000000003', version: [1, 0, 0], entry: 'scripts/main.js' }); }), 'script entry missing'],
      ['a script module whose entry exists', (f) => {
        patchJson(f, `${BP}manifest.json`, (d) => { d.modules.push({ type: 'script', uuid: '0d0d0d0d-0000-4000-8000-000000000003', version: [1, 0, 0], entry: 'scripts/main.js' }); });
        f[`${BP}scripts/main.js`] = 'export {};\n';
      }, 'script entry ok'],
      ['entity identifiers: none, digit-led, upper-case', (f) => {
        f[`${BP}entities/a.json`] = json({ 'minecraft:entity': { description: {} } });
        f[`${BP}entities/b.json`] = json({ 'minecraft:entity': { description: { identifier: 'acme:10303_cart' } } });
        f[`${BP}entities/c.json`] = json({ 'minecraft:entity': { description: { identifier: 'Acme:Thing' } } });
      }, 'Bedrock rejects the identifier'],
      ['a dropped component in components and in a group', (f) => patchJson(f, ENTITY, (d) => {
        d['minecraft:entity'].components['minecraft:pushable'] = {};
        d['minecraft:entity'].component_groups = { g1: { 'minecraft:pushable': {} } };
      }), 'format 1.26.30 dropped'],
      ['custom_hit_test: no boxes, bad boxes, good box', (f) => patchJson(f, ENTITY, (d) => {
        d['minecraft:entity'].components['minecraft:custom_hit_test'] = { hitboxes: [] };
        d['minecraft:entity'].component_groups = {
          g1: { 'minecraft:custom_hit_test': { hitboxes: [{ width: 0, height: 1, pivot: [0, 0, 0] }, { width: 1, height: 1, pivot: [0, 0] }, { width: 2, height: 1.5, pivot: [0, 0.5, 0] }, 7] } },
          g2: { 'minecraft:custom_hit_test': 'x' },
        };
      }), 'custom_hit_test'],
      ['actor property ranges', (f) => patchJson(f, ENTITY, (d) => {
        d['minecraft:entity'].description.properties = { 'acme:a': { type: 'int', range: [0, 0], default: 0 }, 'acme:b': { type: 'float', range: [0, 1], default: 0.5 }, 'acme:c': { type: 'bool', default: false }, 'acme:d': { type: 'float', range: [3, 1] } };
      }), 'is not wider than one value'],
      ['rideables with and without dismount hints (many, so the list is cut at four)', (f) => {
        for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) f[`${BP}entities/ride_${n}.json`] = json({ 'minecraft:entity': { description: { identifier: `acme:ride_${n}` }, components: { 'minecraft:rideable': {} } } });
        f[`${RP}texts/fr_FR.lang`] = '# comment\naction.hint.exit.acme:ride_a=Sortir\nignored line\n';
      }, 'no action.hint.exit line'],
      ['rideables with no language file at all', (f) => {
        f[`${BP}entities/ride.json`] = json({ 'minecraft:entity': { description: { identifier: 'acme:ride' }, components: { 'minecraft:rideable': {} } } });
        delete f[`${RP}texts/en_US.lang`];
      }, 'but no texts/*.lang'],
      ['rideables whose hints are all present', (f) => {
        f[`${BP}entities/ride.json`] = json({ 'minecraft:entity': { description: { identifier: 'acme:ride' }, components: { 'minecraft:rideable': {} } } });
        f[`${RP}texts/en_US.lang`] = '\ufeffaction.hint.exit.acme:ride=Exit\n';
      }, 'dismount hints checked'],
      ['no fly sound entry', (f) => { f[`${RP}sounds.json`] = json({}); }, 'no silent interactive_sounds'],
      ['a fly sound entry that lacks vanilla events', (f) => { f[`${RP}sounds.json`] = json({ interactive_sounds: { block_sounds: { normal: { events: { fly: '', step: '' } } } } }); }, 'lacks vanilla'],
      ['no sounds.json at all', (f) => { delete f[`${RP}sounds.json`]; }, 'an RP sounds.json'],
      ['box-UV cubes under one unit, in two geometries', (f) => {
        f[`${RP}models/entity/acme/demo/thin.geo.json`] = json({
          'minecraft:geometry': [{ description: { identifier: 'geometry.acme.thin' }, bones: [{ cubes: [{ uv: [0, 0], size: [0.5, 1, 1] }, { uv: [0, 0], size: [1, 1, 1] }, { uv: { north: {} }, size: [0, 0, 0] }, { origin: [0, 0, 0] }] }, { name: 'no cubes' }] }],
        });
        f[`${RP}models/entity/acme/demo/thinner.geo.json`] = json({
          'minecraft:geometry': [{ description: { identifier: 'geometry.acme.thinner' }, bones: [{ cubes: [{ uv: [0, 0], size: [1, 0.9, 1] }, { uv: [1, 1], size: [1, 1, 0] }] }] }],
        });
      }, 'box-UV cubes'],
      ['a client entity naming a geometry, a texture and materials the pack lacks', (f) => patchJson(f, `${RP}entity/acme/demo/thing.entity.json`, (d) => {
        const desc = d['minecraft:client_entity'].description;
        desc.geometry.default = 'geometry.acme.ghost';
        desc.textures.default = 'textures/entity/acme/demo/ghost';
        delete desc.materials;
      }), 'is not defined in the pack'],
      ['blocks: a rejected identifier, too many state values, an over-large product', (f) => {
        f[`${BP}blocks/bad.json`] = blockJson('Bad Id', {});
        f[`${BP}blocks/noid.json`] = json({ 'minecraft:block': { description: {} } });
        f[`${BP}blocks/wide.json`] = blockJson('acme:wide', { 'acme:w': Array.from({ length: 17 }, (_, i) => i) });
        f[`${BP}blocks/range.json`] = blockJson('acme:range', { 'acme:r': { values: { min: 0, max: 20 } }, 'acme:q': { values: { min: 0, max: 3 } } });
        f[`${BP}blocks/huge.json`] = blockJson('acme:huge', { a: new Array(16).fill(0), b: new Array(16).fill(0), c: new Array(16).fill(0), d: new Array(16).fill(0), e: new Array(16).fill(0) });
        f[`${BP}blocks/notblock.json`] = json({ 'minecraft:item': {} });
      }, 'registered permutations'],
      ['collision boxes: an array on an old format, too many, out of range, negative size, in a permutation', (f) => {
        f[`${BP}blocks/c1.json`] = blockJson('acme:c1', {}, { components: { 'minecraft:collision_box': [{ origin: [-8, 0, -8], size: [16, 8, 16] }] } }, '1.21.30');
        f[`${BP}blocks/c2.json`] = blockJson('acme:c2', {}, { components: { 'minecraft:collision_box': Array.from({ length: 17 }, () => ({ origin: [-8, 0, -8], size: [1, 1, 1] })) } }, '1.26.0');
        f[`${BP}blocks/c3.json`] = blockJson('acme:c3', {}, { components: { 'minecraft:collision_box': { origin: [-9, 0, -8], size: [16, 16, 16] } }, permutations: [{ condition: 'q.x', components: { 'minecraft:collision_box': { origin: [-8, 0, -8], size: [16, 25, 16] } } }, { components: { 'minecraft:collision_box': false } }, { components: { 'minecraft:collision_box': { size: [-1, 1, 1] } } }, {}] }, '1.26.10');
        f[`${BP}blocks/c4.json`] = blockJson('acme:c4', {}, { components: { 'minecraft:collision_box': true } }, '1.26');
        f[`${BP}blocks/c5.json`] = blockJson('acme:c5', {}, { components: { 'minecraft:collision_box': [{ origin: [-8, 0, -8], size: [16, 24, 16] }] } }, '2.0.0');
      }, 'collision box'],
      ['collider forms the placement script uses, one missing', (f) => {
        // run value = v*136 + pair; characters are code - 40. v=0 (plain collider), v=1 (w1), v=15 (f1), v=29 (c1), v=2 (w2, missing).
        const run = (v: number): string => String.fromCharCode(40 + v * 136 + 1 + 5) + 'A';
        const runs = [0, 1, 15, 29, 2].map(run).join('');
        f[`${BP}scripts/placement.js`] = `// header\nconst CONFIG = ${json({ colliders: { runs } })};\nexport {};\n`;
        f[`${BP}blocks/collider.json`] = blockJson('acme:collider', {});
        f[`${BP}blocks/collider_w1.json`] = blockJson('acme:collider_w1', {});
        f[`${BP}blocks/collider_f1.json`] = blockJson('acme:collider_f1', {});
        f[`${BP}blocks/collider_c1.json`] = blockJson('acme:collider_c1', {});
      }, 'the collider runs use'],
      ['a CRLF placement script, a script with no CONFIG, an empty colliders table', (f) => {
        f[`${BP}scripts/placement.js`] = `const CONFIG = ${json({ colliders: { runs: 'ab' } })};\r\nexport {};\r\n`;
        f[`${BP}other/scripts/placement.js`] = 'const CONFIG = {"colliders":{}};\nexport {};\n';
        f[`${BP}more/scripts/placement.js`] = 'nothing here\n';
      }, 'CRLF'],
    ];

    for (const [name, edit, hint] of cases) {
      it(`parity: ${name}`, () => {
        const { dev, release } = expectParity(variant(edited(edit)));
        const all = [...dev.problems, dev.notes, ...release.problems].join('\n');
        // The case really exercises the rule it names (the CRLF case names no message: it only has to agree).
        if (hint !== 'CRLF') expect(all, `the "${hint}" rule never fired`).toContain(hint);
      });
    }

    it('parity: every dev violation in one archive', () => {
      const f = baseFiles();
      for (const [, edit] of cases) {
        try {
          edit(f);
        } catch {
          // later edits may depend on a pack an earlier one removed
        }
      }
      expectParity(variant(f));
    });

    it('parity: a corrupt archive, an empty archive and a manifest that is not JSON are all reported alike', () => {
      expectParity(variant(new TextEncoder().encode('this is not a zip file')));
      expectParity(variant({}));
      expectParity(variant(edited((f) => { f[`${BP}manifest.json`] = '{ not json'; })));
      expectParity(variant(edited((f) => { f[`${BP}manifest.json`] = '[1, 2]'; })));
    });
  });

  describe('release rules', () => {
    const cases: Array<[string, (f: Files) => void, string]> = [
      ['a resource pack with the wrong pack_scope', (f) => patchJson(f, `${RP}manifest.json`, (d) => { d.header.pack_scope = 'global'; }), "'global'"],
      ['no dependency either way', (f) => { patchJson(f, `${RP}manifest.json`, (d) => { d.dependencies = [{ nope: 1 }, 'x']; }); patchJson(f, `${BP}manifest.json`, (d) => { d.dependencies = []; }); }, 'does not depend on the'],
      ['a behaviour pack alone', (f) => { delete f[`${RP}manifest.json`]; }, 'release needs one behaviour pack'],
      ['two namespaces', (f) => { f[`${BP}entities/acme/demo/other.json`] = json({ 'minecraft:entity': { description: { identifier: 'zed:thing' } } }); }, 'more than one namespace'],
      ['the craftmatic namespace (ids, geometry, animation, controllers)', (f) => {
        f[`${BP}entities/acme/demo/c.json`] = json({ 'minecraft:entity': { description: { identifier: 'craftmatic:thing' } } });
        f[`${RP}models/entity/acme/demo/c.geo.json`] = json({ 'minecraft:geometry': [{ description: { identifier: 'geometry.craftmatic.thing' } }] });
        f[`${RP}animations/acme/demo/c.animation.json`] = json({ animations: { 'animation.craftmatic.x.y': {}, 'animation.nodot': {}, other: {} } });
        f[`${RP}animation_controllers/acme/demo/c.json`] = json({ animation_controllers: { 'controller.animation.craftmatic.go': {} } });
      }, 'development namespace'],
      ['the minecraft namespace', (f) => { f[`${BP}items/acme/demo/over.json`] = json({ 'minecraft:item': { description: { identifier: 'minecraft:stick' } } }); }, 'redefines vanilla content'],
      ['loose files and two creator/pack pairs', (f) => {
        f[`${BP}entities/loose.json`] = json({});
        f[`${BP}entities/acme/loose2.json`] = json({});
        f[`${BP}functions/acme/other/x.mcfunction`] = 'say hi\n';
        f[`${RP}models/entity/a.geo.json`] = json({});
        f[`${RP}textures/ui/b.png`] = png(8, 8);
        f[`${RP}textures/blocks/c.png`] = png(8, 8);
        f[`${RP}particles/d.json`] = json({});
        f[`${RP}fogs/e.json`] = json({});
      }, 'not under <type>/<creator>/<pack>/'],
      ['vanilla texture paths of every pattern', (f) => {
        for (const p of ['textures/blocks/stone.png', 'textures/blocks/planks_oak.tga', 'textures/items/apple.png', 'textures/entity/steve.png', 'textures/entity/creeper/head.png', 'textures/terrain_texture.json', 'textures/item_texture.json', 'textures/blocks/not_vanilla.png', 'textures/blocks/concrete_x.png']) f[`${RP}${p}`] = p.endsWith('.json') ? '{}' : png(8, 8);
        f['textures/flipbook_textures.json'] = '[]';
      }, 'at a vanilla texture path'],
      ['more than 10,000 permutations', (f) => { f[BLOCK] = blockJson('acme:slab', { a: new Array(10).fill(0), b: new Array(10).fill(0), c: new Array(10).fill(0), d: new Array(10).fill(0) }); f[`${BP}blocks/acme/demo/post.json`] = blockJson('acme:post', {}); }, 'a release allows 10,000'],
      ['a pack over 25 MiB uncompressed, 0.25 MiB tie and files over the cap', (f) => { f[`${RP}big.bin`] = new Uint8Array(26 * 1048576 + 262144); }, 'MiB uncompressed'],
      ['more than 3,500 files', (f) => { for (let i = 0; i < 3501; i++) f[`${RP}texts/n${i}.txt`] = ''; }, 'files (a release allows 3,500)'],
      ['oversize textures (png and tga), unreadable images, and a short header', (f) => {
        f[`${RP}textures/blocks/acme/demo/huge.png`] = png(257, 4);
        f[`${RP}textures/items/acme/demo/huge.tga`] = tga(16, 300);
        f[`${RP}textures/entity/acme/demo/big.png`] = png(2049, 2);
        f[`${RP}textures/entity/acme/demo/ok.tga`] = tga(2048, 2048);
        f[`${RP}textures/entity/acme/demo/junk.png`] = new TextEncoder().encode('not an image at all, but long enough to read');
        f[`${RP}textures/entity/acme/demo/short.png`] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
        f[`${RP}textures/top.png`] = new Uint8Array(4);
      }, 'over the size limit'],
      ['beta script modules', (f) => patchJson(f, `${BP}manifest.json`, (d) => { d.dependencies.push({ module_name: '@minecraft/server', version: '1.17.0-BETA' }, { module_name: '@minecraft/server-ui', version: [1, 2, 'beta'] }, { module_name: '@minecraft/stable', version: '1.18.0' }); }), 'beta script module'],
      ['a diagnostics file', (f) => { f[`${BP}acme-diagnostics.json`] = '{}'; f[`${BP}nested/x-diagnostics.json`] = '{}'; }, 'dev diagnostics shipped'],
      ['external download links in text, lang and manifest files', (f) => {
        f[`${RP}texts/en_US.lang`] = 'a=b\nsee https://www.mediafire.com/file/xyz now\r\nhttps://example.com/Download/pack\n';
        f[`${RP}README.md`] = '# Pack\n[get it](https://mega.nz/#F!abc)\n';
        f[`${RP}notes.txt`] = `fine\n   ${'x'.repeat(70)} https://dropbox.com/s/abc   \n\u2028http://drive.google.com/x`;
        patchJson(f, `${RP}manifest.json`, (d) => { d.header.description = 'https://linkvertise.com/pack'; });
      }, 'external download link'],
      ['directory entries inside the archive', (f) => { f[`${BP}entities/`] = new Uint8Array(0); f[`${RP}`] = new Uint8Array(0); f[`${RP}textures/`] = new Uint8Array(0); }, ''],
      ['a pack at the archive root next to a nested one', (f) => {
        f['manifest.json'] = f[`${BP}manifest.json`];
        f['entities/x.json'] = json({ 'minecraft:entity': { description: { identifier: 'acme:x' } } });
      }, ''],
    ];

    for (const [name, edit, hint] of cases) {
      it(`parity: ${name}`, () => {
        const { release } = expectParity(variant(edited(edit)));
        if (hint) expect(release.problems.join('\n'), `the "${hint}" rule never fired`).toContain(hint);
      });
    }

    it('parity: a .zip wrapped in one root folder, and the same files in a .mcaddon', () => {
      const wrapped: Files = {};
      for (const [k, v] of Object.entries(baseFiles())) wrapped[`Wrapper/${k}`] = v;
      const { release } = expectParity(variant(wrapped, 'zip'));
      expect(release.problems.join('\n')).toContain("zip is wrapped in one root folder 'Wrapper'");
      expectParity(variant(wrapped, 'mcaddon'));
      expectParity(variant(wrapped, 'ZIP'));
      expectParity(variant(baseFiles(), 'zip'));
    });

    it('parity: every release violation in one archive', () => {
      const f = baseFiles();
      for (const [, edit] of cases) {
        try {
          edit(f);
        } catch {
          // an edit may rely on a file an earlier edit removed
        }
      }
      expectParity(variant(f));
    });
  });

  describe('real built packs (local-only: output/x02-compare/main)', () => {
    it.skipIf(BUILT_PACKS.length < 3)('pack-check agrees with _mcaddon_check.py --release on three built packs', () => {
      for (const p of BUILT_PACKS) {
        const { dev, release } = expectParity(join(BUILT_DIR, p));
        // A dev-namespace pack: the dev gate is clean, the release gate names the namespace and the layout.
        expect(dev.ok, `${p} dev`).toBe(true);
        expect(release.ok, `${p} release`).toBe(false);
        expect(release.problems.join('\n')).toContain('development namespace');
      }
    });

    it.skipIf(BUILT_PACKS.length < 1)('pack-check agrees with _mcaddon_check.py on a pack rewritten by _marketplace_pack.ts', () => {
      const src = join(BUILT_DIR, [...BUILT_PACKS].sort()[0]);
      const out = join(TMP, 'rewritten.mcaddon');
      const r = spawnSync('bun', [join(ROOT, 'scripts', '_marketplace_pack.ts'), src, '--creator=cmt', '--pack=demo', `--out=${out}`], { encoding: 'utf-8', cwd: ROOT, shell: process.platform === 'win32' });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      const { dev, release } = expectParity(out);
      expect(dev.ok).toBe(true);
      // The rewritten pack no longer trips the namespace or layout rules; the parity above is the point.
      expect(release.problems.join('\n')).not.toContain('development namespace');
      expect(release.problems.join('\n')).not.toContain('not under <type>/<creator>/<pack>/');
    });
  });

  describe('python formatting helpers', () => {
    it('pyRepr matches Python repr for the values a message shows', () => {
      expect(pyRepr(null)).toBe('None');
      expect(pyRepr(true)).toBe('True');
      expect(pyRepr("it's")).toBe('"it\'s"');
      expect(pyRepr('plain')).toBe("'plain'");
      expect(pyRepr(['a', 1, null])).toBe("['a', 1, None]");
      expect(pyRepr({ a: [0, 0], b: 'x' })).toBe("{'a': [0, 0], 'b': 'x'}");
      expect(pyRepr('tab\there\n')).toBe("'tab\\there\\n'");
    });

    it('fixed1 rounds half to even like Python format(x / 1048576, ".1f")', () => {
      expect(fixed1(262144)).toBe('0.2'); // 0.25 MiB: a tie, Python gives 0.2 (JavaScript toFixed gives 0.3)
      expect(fixed1(786432)).toBe('0.8'); // 0.75 MiB: a tie, round half to the even 8
      expect(fixed1(0)).toBe('0.0');
      expect(fixed1(26 * 1048576)).toBe('26.0');
    });
  });
});
