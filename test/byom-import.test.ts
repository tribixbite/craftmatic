/**
 * B01 (BIZ-30): the one model-import service.
 *
 * The parity block pins what the LEGO tab's two import paths produced BEFORE
 * they were folded into `importModelFile` (brick counts, colour space, custom
 * parts, quality), on real corpus files. Corpus tests are gated on the corpus
 * existing and read inside `it` (a skipped `describe` still runs its body).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { importModelFile } from '../web/src/engine/byom/import.js';
import { parseXmlDocument, parseXml, XmlParseError } from '../web/src/engine/byom/xml.js';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { extractIoModel } from '../web/src/engine/io-extractor.js';
import { createZip, extractFile } from '../web/src/engine/zip-utils.js';
import { synthesizeLSynth } from '../web/src/engine/lsynth.js';
import { reconstructionQuality } from '../web/src/engine/source-quality.js';
import { sourceHash12 } from '../web/src/engine/pipeline-version.js';
import {
  applyMeasuredBound, validateElementRow, validateMeasuredAlign, validatePartAlign, validatePrintRow, validateTable,
  ELEMENT_MAP_URL, MEASURED_ALIGN_URL, PART_MAP_URL, PRINT_MAP_URL, type LxfParseOptions,
} from '../web/src/engine/lxf-parser.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const CORPUS = 'C:/git/clego/lego_sets/';
const hasCorpus = existsSync(CORPUS);

const BONE = '1,0,0,0,1,0,0,0,1';
const THREE_BRICKS = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n<LXFML versionMajor="5" versionMinor="0" name="t">'
  + '<Bricks>'
  + `<Brick refID="0" designID="3001"><Part refID="0" designID="3001" materials="21,0"><Bone refID="0" transformation="${BONE},0,0,0"/></Part></Brick>`
  + `<Brick refID="1" designID="3001"><Part refID="1" designID="3001" materials="26,0"><Bone refID="1" transformation="${BONE},4,0,0"/></Part></Brick>`
  + `<Brick refID="2" designID="3020"><Part refID="2" designID="3020" materials="24,0"><Bone refID="2" transformation="${BONE},0,1,0"/></Part></Brick>`
  + '</Bricks></LXFML>';

/** Alignment tables read from the shipped assets, so no test waits on fetch/backoff. */
const publicJson = (f: string): unknown => JSON.parse(readFileSync(`web/public/${f}`, 'utf-8'));
const SHIPPED_TABLES: LxfParseOptions['loaders'] = {
  partMap: async () => validateTable(publicJson('ldd-part-map.json'), PART_MAP_URL, validatePartAlign),
  measured: async () => applyMeasuredBound(validateTable(publicJson('ldd-measured-align.json'), MEASURED_ALIGN_URL, validateMeasuredAlign)),
  printMap: async () => validateTable(publicJson('ldd-print-map.json'), PRINT_MAP_URL, validatePrintRow),
  elementMap: async () => validateTable(publicJson('ldd-element-map.json'), ELEMENT_MAP_URL, validateElementRow),
};

describe('byom-import', () => {
  it('parses a bare .lxfml without DOMParser', async () => {
    expect(typeof (globalThis as { DOMParser?: unknown }).DOMParser).toBe('undefined');
    const m = await importModelFile(enc(THREE_BRICKS), 'three.lxfml', { loaders: SHIPPED_TABLES });
    expect(m.format).toBe('lxfml');
    expect(m.bricks).toHaveLength(3);
    expect(m.bricks.map((b) => b.part)).toEqual(['3001.dat', '3001.dat', '3020.dat']);
    expect(m.lxf).toBeDefined();
    expect(m.hash12).toBe(sourceHash12(enc(THREE_BRICKS)));
  });

  it('a malformed LXFML fails with the LXFML parse error prefix', async () => {
    await expect(importModelFile(enc('<LXFML><Bricks></LXFML>'), 'bad.lxfml', { loaders: SHIPPED_TABLES }))
      .rejects.toThrow(/^LXFML parse error: /);
  });

  it('.io keeps CustomParts and the Studio colour space', async () => {
    // A lone model2.ldr is Studio/BrickLink-space by the per-entry convention.
    const zip = await createZip([
      { name: 'model2.ldr', data: enc('0 Test\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n') },
      { name: 'CustomParts/p/48/1-12edge.dat', data: enc('0 custom primitive\n') },
    ]);
    const m = await importModelFile(zip, 'studio.io');
    expect(m.format).toBe('io');
    expect(m.colorSpace).toBe('bl');
    expect(m.io?.sourceEntry).toBe('model2.ldr');
    expect(m.customParts?.get('p/48/1-12edge.dat')).toContain('custom primitive');
    expect(m.bricks).toHaveLength(1);
    // And a model.ldr is LDraw space with no custom parts => the field is absent, not an empty map.
    const plain = await importModelFile(
      await createZip([{ name: 'model.ldr', data: enc('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n') }]), 'plain.io');
    expect(plain.colorSpace).toBe('ldraw');
    expect(plain.customParts).toBeUndefined();
  });

  it('mpd sub-models are listed with brick indices', async () => {
    const mpd = [
      '0 FILE main.ldr',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '1 16 100 0 0 1 0 0 0 1 0 0 0 1 car.ldr',
      '1 16 200 0 0 1 0 0 0 1 0 0 0 1 3020.dat',
      '0 FILE car.ldr',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '1 4 20 0 0 1 0 0 0 1 0 0 0 1 wheel.ldr',
      '0 FILE wheel.ldr',
      '1 0 0 0 0 1 0 0 0 1 0 0 0 1 3023.dat',
      '',
    ].join('\n');
    const m = await importModelFile(enc(mpd), 'car.mpd');
    expect(m.format).toBe('mpd');
    expect(m.bricks).toHaveLength(4);
    const byName = Object.fromEntries(m.submodels.map((s) => [s.name, s.brickIndices]));
    expect(byName['car.ldr']).toEqual([1, 2]); // its own brick and the nested wheel
    expect(byName['wheel.ldr']).toEqual([2]);
    expect(m.submodels.map((s) => s.name)).toEqual(['car.ldr', 'wheel.ldr']);
    expect(m.ldrawText).toBe(mpd);
  });

  it('warnings are returned, not written to a global', async () => {
    const before = Object.keys(globalThis).sort();
    const broken = '0 x\n0 Author: convert_lxf.py\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n';
    const upload = await importModelFile(enc(broken), 'a.ldr');
    const indexed = await importModelFile(enc(broken), 'a.ldr', { sourceNoun: 'source' });
    expect(upload.quality).toBe('broken');
    expect(upload.warnings).toEqual([expect.stringMatching(/^this file is an unaligned LXFML conversion/)]);
    expect(indexed.warnings).toEqual([expect.stringMatching(/^this source is an unaligned LXFML conversion/)]);
    const clean = await importModelFile(enc('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n'), 'b.ldr');
    expect(clean.warnings).toEqual([]);
    expect(Object.keys(globalThis).sort()).toEqual(before);
  });

  it('a zip yields the first model inside', async () => {
    const zip = await createZip([
      { name: 'readme.txt', data: enc('hello') },
      { name: 'first.ldr', data: enc('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 40 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n') },
      { name: 'second.ldr', data: enc('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat\n') },
    ]);
    const m = await importModelFile(zip, 'bundle.zip');
    expect(m.file).toBe('bundle.zip');
    expect(m.entry).toBe('first.ldr');
    expect(m.format).toBe('ldr');
    expect(m.bricks).toHaveLength(2);
    expect(m.hash12).toBe(sourceHash12(zip));
    await expect(importModelFile(await createZip([{ name: 'a.txt', data: enc('x') }]), 'none.zip')).rejects.toThrow(/No model file/);
  });
});

describe('byom-xml', () => {
  it('reads attributes, entities, comments, CDATA and self-closing tags', () => {
    const doc = parseXmlDocument('\ufeff<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><!-- c --><A k=\'1\'><B n="a&amp;b&#65;&#x42;"/><![CDATA[<B/>]]><C><B n="deep"/></C></A>');
    const bs = [...doc.querySelectorAll('B')];
    expect(bs.map((b) => b.getAttribute('n'))).toEqual(['a&bAB', 'deep']);
    expect(bs[0]!.getAttribute('missing')).toBeNull();
    expect([...doc.querySelectorAll('A')]).toHaveLength(1);
  });

  it('rejects what is not well-formed', () => {
    for (const bad of ['', '<a>', '<a></b>', '<a/><b/>', '<a b="1" b="2"/>', '<a b=1/>', '<a><!-- x </a>']) {
      expect(() => parseXml(bad), bad).toThrow(XmlParseError);
    }
  });

  // DOMParser does not exist in the node test environment, so the reference is
  // Python's expat-based ElementTree: an independent XML reader.
  const python = spawnSync('python', ['-I', '-c', 'import xml.etree.ElementTree']).status === 0;
  const PY = 'import sys,json,xml.etree.ElementTree as E\n'
    + 'r=E.fromstring(sys.stdin.buffer.read())\n'
    + 'print(json.dumps([[b.get("designID"),b.get("itemNos"),p.get("designID"),p.get("materials"),p.get("decoration"),[x.get("transformation") for x in p.iter("Bone")]] '
    + 'for b in r.iter("Brick") for p in b.iter("Part")]))';
  const records = (xml: string): unknown => {
    const doc = parseXmlDocument(xml);
    return [...doc.querySelectorAll('Brick')].flatMap((b) => [...b.querySelectorAll('Part')].map((p) => [
      b.getAttribute('designID'), b.getAttribute('itemNos'), p.getAttribute('designID'), p.getAttribute('materials'),
      p.getAttribute('decoration'), [...p.querySelectorAll('Bone')].map((x) => x.getAttribute('transformation')),
    ]));
  };

  it('xml.ts and an independent XML reader agree on a corpus LXFML', async () => {
    const files = ['DBIX_LXFML/60297.lxfml', 'DBIX_LXFML/30385_30385_sm01.lxfml'].map((f) => CORPUS + f).filter(existsSync);
    if (!python || !hasCorpus || files.length === 0) return; // local-only
    for (const f of files) {
      const xml = readFileSync(f, 'utf-8');
      const ref = spawnSync('python', ['-I', '-c', PY], { input: Buffer.from(xml, 'utf-8'), maxBuffer: 1 << 28 });
      expect(ref.status, ref.stderr?.toString()).toBe(0);
      const expected = JSON.parse(ref.stdout.toString()) as unknown[];
      expect(expected.length).toBeGreaterThan(0);
      expect(records(xml)).toEqual(expected);
    }
    // And through a zipped .lxf, via the same reader the import uses.
    const lxf = CORPUS + 'LXF/10071_eurobricks.lxf';
    if (existsSync(lxf)) {
      const b = readFileSync(lxf);
      const inner = new TextDecoder().decode(await extractFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, 'IMAGE100.LXFML'));
      const ref = spawnSync('python', ['-I', '-c', PY], { input: Buffer.from(inner, 'utf-8'), maxBuffer: 1 << 28 });
      expect(records(inner)).toEqual(JSON.parse(ref.stdout.toString()));
    }
  });
});

/**
 * What each existing LEGO-tab path produced before the refactor, recorded from
 * the pre-refactor composition (extractIoModel / synthesize / parseLDraw /
 * reconstructionQuality) on real files. `ldrawText`, colour space and custom
 * parts are compared against that same composition, so a drift in either side fails.
 */
const PINNED: ReadonlyArray<{ file: string; bricks: number; colorSpace: 'ldraw' | 'bl'; customParts: number }> = [
  { file: 'IO/001-1.io', bricks: 43, colorSpace: 'ldraw', customParts: 0 },
  { file: 'IO/10020 Santa Fe Super Cheif.io', bricks: 442, colorSpace: 'ldraw', customParts: 3 },
  { file: 'OMR/10001-1.mpd', bricks: 848, colorSpace: 'ldraw', customParts: 0 },
  { file: 'OMR/10002-1.mpd', bricks: 338, colorSpace: 'ldraw', customParts: 0 },
  { file: 'LxfmlDirect/42703.ldr', bricks: 904, colorSpace: 'ldraw', customParts: 0 },
];

describe('byom-import corpus parity', () => {
  for (const pin of PINNED) {
    it(`${pin.file} imports as the LEGO tab did`, async () => {
      if (!existsSync(CORPUS + pin.file)) return; // local-only
      const bytes = new Uint8Array(readFileSync(CORPUS + pin.file));
      // The pre-refactor composition, verbatim.
      let text: string;
      if (pin.file.endsWith('.io')) {
        text = (await extractIoModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)).text;
      } else {
        text = new TextDecoder().decode(bytes);
      }
      text = synthesizeLSynth(text).text;
      const legacy = parseLDraw(text);

      const m = await importModelFile(bytes, pin.file.split('/').pop()!);
      expect(m.bricks).toEqual(legacy);
      expect(m.bricks).toHaveLength(pin.bricks);
      expect(m.colorSpace).toBe(pin.colorSpace);
      expect(m.customParts?.size ?? 0).toBe(pin.customParts);
      expect(m.ldrawText).toBe(text);
      expect(m.quality).toBe(reconstructionQuality(text));
      expect(m.hash12).toBe(sourceHash12(bytes));
    }, 120000);
  }

  it('a corpus .lxf imports through the DOM-free reader', async () => {
    const f = CORPUS + 'LXF/10071_eurobricks.lxf';
    if (!existsSync(f)) return; // local-only
    const m = await importModelFile(new Uint8Array(readFileSync(f)), '10071_eurobricks.lxf', { loaders: SHIPPED_TABLES });
    expect(m.format).toBe('lxf');
    expect(m.bricks.length).toBeGreaterThan(0);
    expect(m.lxf?.table.state).toBe('ok');
  });
});
