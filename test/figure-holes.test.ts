/**
 * Minifigs with unclosed faces (user report 2026-09-29, round 29b packs). Two
 * causes, measured in `output/fig-faces-0929/`:
 *
 *  1. Bedrock floors a box-UV cube's DECLARED size before laying out its UV
 *     and does not draw a side face whose height floors to 0. At 0.3 units per
 *     LDU a figure's 2 LDU grain is 0.6 units: every figure of the round lost
 *     visible faces (the Pixel probe: a 3 x 0.6 x 0.6 cube had no front face,
 *     a 0.6 x 3 x 0.6 one did). Fixed by declaring such cubes size + 2 with
 *     inflate -1 (`boxUvSafeCube`), the same drawn box.
 *  2. The hidden-cube cull let cuboids of one animated bone hide another's:
 *     7140's pilot showed the world through his hips at rest. Fixed by culling
 *     within each rig bone only.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { boxUvSafeCube, compileLdrawEntityGeometry, cullHiddenCuboids } from '../web/src/engine/ldraw-entity-compiler.js';
import { boxUvFaceDrawn, droppedVisibleArea, entryFromCompiled, figureHoles, figureReferenceSurfaces } from '../web/src/engine/figure-holes.js';
import { buildAddonAppearance } from '../web/src/ui/addon-appearance.js';
import { worldFaces } from '../web/src/engine/bedrock-geometry-faces.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';
import { setLDrawRoot, seedDatTexts } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';
import { embeddedPartTexts, parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { synthesizeLSynth } from '../web/src/engine/lsynth.js';
import { assembleMinifig } from '../web/src/engine/minifig-rig.js';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.js';
import type { Vec3 } from '../web/src/engine/bedrock-geometry-faces.js';

const ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const X_WING = 'C:/git/clego/lego_sets/LDR/7140 X-wing Fighter.ldr';

/** The probe card's eight test cubes (model units) and whether the Pixel drew each one's front face. */
const PROBE: Array<{ name: string; size: Vec3; frontDrawn: boolean }> = [
  { name: 'T1 0.6^3', size: [0.6, 0.6, 0.6], frontDrawn: false },
  { name: 'T2 3x0.6x0.6', size: [3, 0.6, 0.6], frontDrawn: false },
  { name: 'T3 0.6x3x0.6', size: [0.6, 3, 0.6], frontDrawn: true },
  { name: 'T4 3x3x0.6', size: [3, 3, 0.6], frontDrawn: true },
  { name: 'T5 1x1x1', size: [1, 1, 1], frontDrawn: true },
  { name: 'T6 0.9x0.9x3', size: [0.9, 0.9, 3], frontDrawn: false },
  { name: 'T7 3x3x3', size: [3, 3, 3], frontDrawn: true },
  { name: 'T8 2x2x0.3', size: [2, 2, 0.3], frontDrawn: true },
];

describe('box UV floor: what the device drops, and the declared-size fix', () => {
  it('models the Pixel probe: a side face is dropped when its declared HEIGHT floors to 0', () => {
    for (const t of PROBE) {
      expect(boxUvFaceDrawn({ size: t.size }, 'north', 'v'), t.name).toBe(t.frontDrawn);
      expect(boxUvFaceDrawn({ size: t.size }, 'south', 'v'), t.name).toBe(t.frontDrawn);
    }
  });

  it('declares a cube under one unit as size + 2 with inflate -1, and every face is then drawn', () => {
    for (const t of PROBE) {
      const cube = { origin: [1, 2, 3] as Vec3, size: [...t.size] as Vec3, uv: [0, 0] as [number, number] };
      const changed = boxUvSafeCube(cube);
      expect(changed, t.name).toBe(t.size.some(s => s < 1));
      if (!changed) continue;
      expect(cube.inflate).toBe(-1);
      // Drawn box = declared box shrunk by one unit on every side: unchanged.
      expect(cube.origin).toEqual([0, 1, 2]);
      expect(cube.size.map(v => Math.round((v - 2) * 100) / 100)).toEqual(t.size);
      for (const face of ['north', 'south', 'east', 'west', 'up', 'down']) expect(boxUvFaceDrawn({ size: t.size, uvSize: cube.size }, face, 'v')).toBe(true);
    }
    // A face decal (per-face UV) names its own UV size: never touched.
    const decal = { origin: [0, 0, 0] as Vec3, size: [0.2, 0.2, 0.2] as Vec3, uv: { north: { uv: [0, 0], uv_size: [4, 4] } } };
    expect(boxUvSafeCube(decal)).toBe(false);
  });

  it('reads an inflated cube back as the box it draws (pack reader), keeping the declared size for the UV', () => {
    const geo = {
      format_version: '1.12.0',
      'minecraft:geometry': [{
        description: { identifier: 'geometry.t.probe', texture_width: 16, texture_height: 16 },
        bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [-1, 13, -1.5], size: [5, 2.6, 2.6], inflate: -1, uv: [0, 0] }] }],
      }],
    };
    const sources = new Map<string, string>([
      ['RP/models/entity/t.geo.json', JSON.stringify(geo)],
      ['RP/entity/t.entity.json', JSON.stringify({ format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: 't:probe', textures: { default: 'textures/entity/craftmatic_swatch_0' }, geometry: { mesh_0: 'geometry.t.probe' }, render_controllers: ['controller.render.t.probe'] } } })],
      ['RP/render_controllers/t.render_controllers.json', JSON.stringify({ format_version: '1.8.0', render_controllers: { 'controller.render.t.probe': { geometry: 'Geometry.mesh_0', textures: ['Texture.default'], materials: [{ '*': 'Material.default' }] } } })],
    ]);
    const entry = buildAddonAppearance(sources).byType.get('t:probe');
    expect(entry).toBeDefined();
    const cube = entry!.groups[0]!.cubes[0]!;
    expect(cube.origin).toEqual([0, 14, -0.5]);
    [3, 0.6, 0.6].forEach((v, i) => expect(cube.size[i]).toBeCloseTo(v, 9));
    expect(cube.uvSize).toEqual([5, 2.6, 2.6]);
    const ys = worldFaces([{ typeId: 't', kind: 'figure', entry: entry!, at: { x: 0, y: 0, z: 0 }, yawDeg: 0 }]).flatMap(f => f.corners.map(c => c[1]));
    expect(Math.min(...ys)).toBeCloseTo(14, 6);
    expect(Math.max(...ys)).toBeCloseTo(14.6, 6);
  });
});

describe('hidden-cube cull on a rig', () => {
  it('lets a cuboid be hidden only by cuboids of its own bone group', () => {
    // A hip cube boxed in on every side by leg and body cubes.
    const box = (min: Vec3, max: Vec3, group: string) => ({ min, max, translucent: false, aligned: true, group });
    const hip = box([4, 4, 4], [8, 8, 8], 'hips');
    const around = [
      box([0, 0, 0], [12, 4, 12], 'leg_left'), box([0, 8, 0], [12, 12, 12], 'body'),
      box([0, 4, 0], [4, 8, 12], 'leg_left'), box([8, 4, 0], [12, 8, 12], 'leg_right'),
      box([4, 4, 0], [8, 8, 4], 'leg_right'), box([4, 4, 8], [8, 8, 12], 'body'),
    ];
    const ungrouped = [hip, ...around].map(({ group: _g, ...c }) => c);
    expect(cullHiddenCuboids(ungrouped, 2).has(0)).toBe(true);
    expect(cullHiddenCuboids([hip, ...around], 2).has(0)).toBe(false);
    // Within one group the cull still works.
    const same = [hip, ...around].map(c => ({ ...c, group: 'body' }));
    expect(cullHiddenCuboids(same, 2).has(0)).toBe(true);
  });
});

describe.skipIf(!existsSync(ROOT))('figures on the real library: no face the device drops, no hole the parts do not have', () => {
  const setup = async (bricks: Parameters<typeof compileLdrawEntityGeometry>[2], provider = createPartGeometryProvider()) => {
    const meshes = new Map<string, LdrawPartMesh | null>();
    for (const b of bricks) meshes.set(b.part, await provider.getPartMesh(b.part));
    return { provider, meshes };
  };

  it('a standard minifig with hair: the round-29b compile lost surface on the device, the fixed one loses none, same cube count', async () => {
    setLDrawRoot(ROOT);
    const figure = minifigFromSpec({ torso: { part: '973', color: 4 }, head: { part: '3626c', color: 14 }, hair: { part: '3901', color: 6 }, legs: { right: '3816', left: '3817', color: 1 }, arms: { right: '3818', left: '3819', color: 4 } });
    const { provider, meshes } = await setup(figure.bricks);
    const before = await compileLdrawEntityGeometry('before', 'figure', figure.bricks, { partGeometry: provider, boxUvFloorSafe: false });
    const after = await compileLdrawEntityGeometry('after', 'figure', figure.bricks, { partGeometry: provider });
    const eb = entryFromCompiled(before), ea = entryFromCompiled(after);
    const views = ['+x', '-x', '+y', '-y', '+z', '-z'];
    expect(droppedVisibleArea(eb, 'v', { views }).share).toBeGreaterThan(0.05);
    expect(droppedVisibleArea(ea, 'v', { views }).area).toBe(0);
    expect(after.diagnostics.boxUvInflated).toBeGreaterThan(0);
    expect(after.diagnostics.cubeCount).toBe(before.diagnostics.cubeCount);
    // See-through holes the real parts do not have, in every pose, under the device's rule.
    const reference = figureReferenceSurfaces(figure.bricks, meshes, after);
    expect(figureHoles(eb, { reference, uvFloor: 'v' }).holes.length).toBeGreaterThan(0);
    expect(figureHoles(ea, { reference, uvFloor: 'v' }).holes).toEqual([]);
  }, 60_000);

  it.skipIf(!existsSync(X_WING))('7140\'s pilot: no see-through hole at the hips in any pose (the cross-bone cull)', async () => {
    setLDrawRoot(ROOT);
    const doc = parseLDrawDocument(synthesizeLSynth(readFileSync(X_WING, 'utf8')).text);
    seedDatTexts([...embeddedPartTexts(doc)]);
    const provider = createPartGeometryProvider();
    const scene = await discoverSceneActors(doc.bricks, provider);
    expect(scene.figures.length).toBe(3);
    for (const [k, fig] of scene.figures.entries()) {
      const { meshes } = await setup(fig.bricks, provider);
      const geo = await compileLdrawEntityGeometry(`p${k}`, 'figure', fig.bricks, { partGeometry: provider });
      for (const b of assembleMinifig(fig.bricks, meshes).bricks) if (!meshes.has(b.part)) meshes.set(b.part, await provider.getPartMesh(b.part));
      const reference = figureReferenceSurfaces(fig.bricks, meshes, geo);
      const holes = figureHoles(entryFromCompiled(geo), { reference, uvFloor: 'v' }).holes;
      expect(holes.filter(h => h.bones.includes('hips')), `figure ${k + 1}`).toEqual([]);
    }
  }, 120_000);
});
