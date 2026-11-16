/**
 * The export/entity part resolver (`engine/ldraw-geometry.ts`) must reach the
 * same names the viewer does: after a definitive library miss it walks the
 * alias ladder (`6538c` → `6538`) and records the substitution, so a CLI or
 * Worker export of a model the viewer rendered whole does not grow holes.
 * Offline: a temp library on disk, the prod mirror disabled.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datSubstitutionFor, getDatText, setLDrawMirror, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { partAliasCandidates, synthesizedPartText } from '../web/src/engine/ldraw-part-aliases.js';

const BRICK = ['0 Brick 1 x 1', '4 16 -10 -24 -10 10 -24 -10 10 -24 10 -10 -24 10', '4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10'].join('\n');
/** A 1x4x6 door leaf in the official frame (origin at its head, body y 4..136) and Studio's stub of it (origin at its foot, y -140..-8). */
const DOOR_OFFICIAL = ['0 Door  1 x  4 x  6 Smooth with Square Handle Plinth', '4 16 0 4 0 67 4 0 67 136 0 0 136 0'].join('\n');
const DOOR_STUDIO_STUB = ['0 GLASS DOOR FOR FRAME 1X4X6 (Needs Work)', '4 16 0 -140 0 67 -140 0 67 -8 0 0 -8 0'].join('\n');

describe('export resolver alias ladder', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'craftmatic-ldraw-'));
    mkdirSync(join(root, 'parts'), { recursive: true });
    mkdirSync(join(root, 'p'), { recursive: true });
    writeFileSync(join(root, 'parts', '6538.dat'), BRICK);
    writeFileSync(join(root, 'parts', '3626a.dat'), BRICK);
    writeFileSync(join(root, 'parts', '41669.dat'), BRICK);
    mkdirSync(join(root, 'UnOfficial', 'parts'), { recursive: true });
    writeFileSync(join(root, 'parts', '60616a.dat'), DOOR_OFFICIAL);
    writeFileSync(join(root, 'UnOfficial', 'parts', '60616.dat'), DOOR_STUDIO_STUB);
    writeFileSync(join(root, 'parts', '4739a.dat'), BRICK);
    // The rigid hose's two library pieces, as LDraw ships them: the end (a short tube from y 0 up to y 1 here) and
    // the unit segment (y 0..1) the hose's matrix stretches.
    writeFileSync(join(root, 'parts', 'u9053.dat'), ['0 ~Technic Flex-System Hose End', '3 16 -2 0 0 2 0 0 0 1 2'].join('\n'));
    writeFileSync(join(root, 'parts', '77.dat'), ['0 ~Technic Flex-System Hose Segment', '3 16 -2 0 0 2 0 0 0 1 2'].join('\n'));
    // Two unit primitives LSynth's segment parts are built from: a cylinder wall (radius 1, y 0..1) and a disc.
    writeFileSync(join(root, 'p', '4-4cyli.dat'), ['0 Cylinder 1.0', '4 16 1 1 0 1 0 0 -1 0 0 -1 1 0'].join('\n'));
    writeFileSync(join(root, 'p', '4-4disc.dat'), ['0 Disc 1.0', '3 16 0 0 0 1 0 0 0 0 1'].join('\n'));
    setLDrawRoot(root);
    setLDrawMirror(null);
  });
  afterAll(() => { setLDrawMirror('https://craftmatic.click/ldraw-parts'); });

  it('is the same ladder the viewer uses', () => {
    expect(partAliasCandidates('6538c')).toEqual(['6538']);
    expect(partAliasCandidates('3626ad1024')).toEqual(['3626a', '3626']); // chained: decoration, then the mould letter
    expect(partAliasCandidates('stud4')).toEqual([]);
  });

  it('serves a lettered mould revision from its base and records the stand-in', async () => {
    expect(await getDatText('6538c')).toBe(BRICK);
    expect(datSubstitutionFor('6538c')).toBe('6538');
    expect(datSubstitutionFor('6538')).toBeUndefined();
  });

  it('walks chained suffixes and reports the substitution through the geometry provider', async () => {
    const provider = createPartGeometryProvider();
    const mesh = await provider.getPartMesh('3626ad1024');
    expect(mesh).not.toBeNull();
    expect(mesh!.triangles).toHaveLength(4);
    expect(provider.report().substitutions).toEqual([{ part: '3626ad1024', alias: '3626a' }]);
    expect(provider.report().unresolved).toEqual([]);
  });

  it('still reports a name nothing resolves as unresolved, never as a silent box', async () => {
    // 88355 has no strippable suffix and no LDRAW_PART_ALIASES entry (see
    // ldraw-part-aliases.ts) — genuinely nothing to offer, unlike x346 below.
    expect(await getDatText('88355')).toBeNull();
    expect(datSubstitutionFor('88355')).toBeUndefined();
    const provider = createPartGeometryProvider();
    expect(await provider.getPartMesh('88355')).toBeNull();
    expect(provider.report().unresolved).toEqual(['88355']);
  });

  it('resolves the design-id alias (x346 → 41669) through the export resolver too', async () => {
    // Same table the viewer uses (part-alias.test.ts pins the identity/frame
    // evidence); this just confirms ldraw-geometry.ts's independent fetch path
    // reaches the same substitution when the target actually exists in the
    // configured library.
    expect(await getDatText('x346')).toBe(BRICK);
    expect(datSubstitutionFor('x346')).toBe('41669');
    const provider = createPartGeometryProvider();
    const mesh = await provider.getPartMesh('x346');
    expect(mesh).not.toBeNull();
    expect(provider.report().substitutions).toContainEqual({ part: 'x346', alias: '41669' });
    expect(provider.report().unresolved).toEqual([]);
  });

  it('reads a Studio-shadowed name as its official mould, not the local stub in another frame', async () => {
    // 60616: Studio's UnOfficial stub sits a door height above the official
    // 60616a (STUDIO_FRAME_REDIRECTS). The stub is FOUND, so only a redirect
    // ahead of the probe keeps it from being drawn.
    expect(await getDatText('60616')).toBe(DOOR_OFFICIAL);
    expect(datSubstitutionFor('60616')).toBeUndefined();
    const mesh = await createPartGeometryProvider().getPartMesh('60616');
    expect(mesh!.bounds.min[1]).toBeGreaterThanOrEqual(0); // body runs DOWN from the origin, as the frame 60596's
  });

  it('never applies the ladder to a primitive path', async () => {
    expect(await getDatText('s/6538cs01')).toBeNull();
    expect(datSubstitutionFor('s/6538cs01')).toBeUndefined();
  });

  it('reads a Studio `rename_` marker as the name it marks (A-07: the 910049 chest lid shipped as a box)', async () => {
    // IOModel2V2 sources keep Studio's `rename_<id>` while the same .io's LDraw-space model.ldr places plain `<id>`
    // at the identical matrix (910049-closed: `rename_4739a` / `4739a`, Treasure Chest Lid), so the marker carries no
    // geometry of its own.
    expect(partAliasCandidates('rename_4739a')[0]).toBe('4739a');
    expect(partAliasCandidates('rename_3626bpb17')[0]).toBe('3626bpb17');
    expect(await getDatText('rename_4739a')).toBe(BRICK);
    expect(datSubstitutionFor('rename_4739a')).toBe('4739a');
  });

  it('generates a STRAIGHT rigid 3mm hose (75cNN) from its LDraw end and segment, Studio\'s own construction', async () => {
    // Studio defines 75c08 as u9053 at 0, 77 stretched 158 from y 1, u9053 turned at y 160: N studs = 20 N LDU.
    const text = synthesizedPartText('75c08')!;
    expect(text).toContain('1 16 0 1 0 1 0 0 0 158 0 0 0 1 77.dat');
    expect(text).toContain('1 16 0 160 0 -1 0 0 0 -1 0 0 0 1 u9053.dat');
    expect(synthesizedPartText('75c5')).toBeNull();
    expect(synthesizedPartText('3001')).toBeNull();
    const provider = createPartGeometryProvider();
    const mesh = await provider.getPartMesh('75c20');
    expect(mesh).not.toBeNull();
    expect(mesh!.bounds.min[1]).toBeCloseTo(0, 5);
    expect(mesh!.bounds.max[1]).toBeCloseTo(400, 5);
    expect(provider.report().unresolved).toEqual([]);
  });

  it('reads a BrickLink item number as the LDraw part that IS it, and measured Mecabricks design ids as their LDraw mould (generality census 2026-11-16)', () => {
    // 910035: `55423c01` (BrickLink, train wheel with its rubber ring) is LDraw's `55423` - its `!KEYWORDS BrickLink
    // 55423c01` - and Studio's own 910035.io writes its composite of the same two sub-parts at the identical matrix.
    expect(partAliasCandidates('55423c01')[0]).toBe('55423');
    // Mecabricks design ids whose mesh, in the harvest's frame, bounds like the LDraw mould (centres within 0.3 LDU).
    expect(partAliasCandidates('4973')[0]).toBe('30602');
    // A decorated id reaches the mould's row through the ladder's hop (52684d1 -> 52684 -> Studio's bl_ copy).
    expect(partAliasCandidates('52684d1')).toEqual(['52684', 'bl_52684pb05']);
    // An LDD design id Studio maps to its own copy with a zero transform (IOModel2V2 77072's banana bunch).
    expect(partAliasCandidates('3566')[0]).toBe('bl_3566');
  });

  it('draws LSynth segment parts (lsNN) from LSynth\'s own part files, which no library ships (8097: 40 ls11 boxes)', async () => {
    // LSynth writes a synthesised hose / band as many placements of its OWN parts; the tool ships them, LDraw does
    // not. LS11 is the NXT cable segment: a unit cylinder of radius 1 from y 0 to y 1, which each placement's matrix
    // stretches along the path and scales across (8097's rubber band: 2).
    const ls11 = synthesizedPartText('ls11')!;
    expect(ls11).toContain('0 ~LSynth Electric Cable Segment NXT');
    expect(ls11).toContain('1 16 0 0 0 1 0 0 0 1 0 0 0 1 4-4cyli.dat');
    expect(synthesizedPartText('LS51')).toContain('Flex-System Hose - Cross Section'); // names are case-blind
    expect(synthesizedPartText('ls61')).toContain('LS60.dat'); // the string-with-grips segment IS a shifted LS60
    expect(synthesizedPartText('ls01')).toContain('Constraint Part - Type 1');
    expect(synthesizedPartText('6397 - LS60')).toContain('Short Straight String Segment'); // OMR's embedded name
    expect(synthesizedPartText('ls999')).toBeNull();
    expect(synthesizedPartText('lsynth-3')).toBeNull();
    const provider = createPartGeometryProvider();
    const mesh = await provider.getPartMesh('LS11.dat');
    expect(mesh).not.toBeNull();
    expect(mesh!.bounds.min[1]).toBeCloseTo(0, 5);
    expect(mesh!.bounds.max[1]).toBeCloseTo(1, 5);
    expect(mesh!.bounds.max[0]).toBeCloseTo(1, 5);
    expect(provider.report().unresolved).toEqual([]);
  });
});
