import { describe, expect, it } from 'vitest';
import { APPEARANCE_FILE_PATTERN, buildAddonAppearance, readAppearancePbrMaterials, swatchColorId } from '../web/src/ui/addon-appearance.js';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';
import { encodePngRgba } from '../web/src/engine/lego-resource-pack.js';
import { addonAppearanceMaterial, faceDecalGeometry } from '../web/src/ui/addon-preview.js';
import { decodePngRgb8 } from '../web/src/engine/png-rgb8.js';
import * as THREE from 'three';

/**
 * The preview's model layer is read back out of a built pack, so it can only be
 * trusted if it follows the same bindings Bedrock does: a client entity names
 * render controllers, each controller picks one geometry and one texture, and
 * the texture's swatch names the LDraw colour. Getting any hop wrong would draw
 * a model in the wrong colours — or draw nothing while looking like it worked,
 * which is the failure mode this preview exists to catch.
 */
const entity = (identifier: string) => JSON.stringify({
  'minecraft:client_entity': {
    description: {
      identifier,
      geometry: { mesh_0: 'geometry.craftmatic.shell_mesh_0', mesh_1: 'geometry.craftmatic.shell_mesh_1' },
      textures: { default: 'textures/entity/craftmatic_swatch_4', tex_1: 'textures/entity/craftmatic_swatch_2' },
      render_controllers: [
        'controller.render.craftmatic.shell_mesh_0',
        'controller.render.craftmatic.shell_mesh_1',
      ],
    },
  },
});

const controllers = JSON.stringify({
  render_controllers: {
    // The LOD shape the compiler emits: index 0 is the near mesh.
    'controller.render.craftmatic.shell_mesh_0': {
      arrays: { geometries: { 'Array.g': ['Geometry.mesh_0', 'Geometry.empty'] } },
      geometry: "Array.g[query.distance_from_camera > 146.3]",
      textures: ['Texture.default'],
    },
    'controller.render.craftmatic.shell_mesh_1': {
      geometry: 'Geometry.mesh_1',
      textures: ['Texture.tex_1'],
    },
  },
});

const geo = JSON.stringify({
  format_version: '1.12.0',
  'minecraft:geometry': [
    {
      description: { identifier: 'geometry.craftmatic.shell_mesh_0' },
      bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [
        { origin: [0, 0, 0], size: [16, 8, 16], uv: [0, 0] },
        { origin: [16, 0, 0], size: [8, 8, 8], uv: [0, 0], rotation: [0, 45, 0], pivot: [20, 4, 4] },
      ] }],
    },
    {
      description: { identifier: 'geometry.craftmatic.shell_mesh_1' },
      bones: [
        { name: 'body', pivot: [0, 0, 0] },
        { name: 'r7', parent: 'body', pivot: [4, 4, 4], rotation: [0, 90, 0], cubes: [{ origin: [0, 0, 0], size: [4, 4, 4], uv: [0, 0] }] },
      ],
    },
  ],
});

const sources = (): Map<string, string> => new Map([
  ['Craftmatic_RP/entity/shell.entity.json', entity('craftmatic:b_shell')],
  ['Craftmatic_RP/render_controllers/shell.render_controllers.json', controllers],
  ['Craftmatic_RP/models/entity/shell.geo.json', geo],
]);

describe('APPEARANCE_FILE_PATTERN', () => {
  it('matches the three resource-pack file kinds and nothing else', () => {
    expect(APPEARANCE_FILE_PATTERN.test('X_RP/entity/a.entity.json')).toBe(true);
    expect(APPEARANCE_FILE_PATTERN.test('X_RP/render_controllers/a.render_controllers.json')).toBe(true);
    expect(APPEARANCE_FILE_PATTERN.test('X_RP/models/entity/a.geo.json')).toBe(true);
    expect(APPEARANCE_FILE_PATTERN.test('X_RP/manifest.json')).toBe(true);
    expect(APPEARANCE_FILE_PATTERN.test('X_RP/textures/entity/a.texture_set.json')).toBe(true);
    expect(APPEARANCE_FILE_PATTERN.test('X_BP/scripts/placement.js')).toBe(false);
    expect(APPEARANCE_FILE_PATTERN.test('X_RP/textures/entity/craftmatic_swatch_4.png')).toBe(false);
  });
});

const rpManifest = (pbr: boolean): string => JSON.stringify({
  modules: [{ type: 'resources' }], ...(pbr ? { capabilities: ['pbr'] } : {}),
});
const textureSet = (mer: unknown): string => JSON.stringify({
  format_version: '1.16.100', 'minecraft:texture_set': { color: 'ignored', metalness_emissive_roughness: mer },
});
const uniformPng = (rgb: readonly [number, number, number]): Uint8Array => {
  const data = new Uint8Array(2 * 2 * 4);
  for (let p = 0; p < data.length; p += 4) data.set([...rgb, 255], p);
  return encodePngRgba(2, 2, data);
};

describe('pack-authored PBR material response', () => {
  it('rejects malformed PNG framing before material parsing', async () => {
    const valid = uniformPng([0, 0, 92]);
    expect(await decodePngRgb8(valid)).toMatchObject({ width: 2, height: 2, channels: 4 });
    await expect(decodePngRgb8(valid.slice(0, -12))).rejects.toThrow(/IEND/);
    const trailing = new Uint8Array(valid.length + 1); trailing.set(valid); trailing[valid.length] = 1;
    await expect(decodePngRgb8(trailing)).rejects.toThrow(/trailing bytes/);
  });

  it('reads inline MER exactly and requires the resource manifest PBR flag', async () => {
    const withFlag = sources();
    withFlag.set('Craftmatic_RP/manifest.json', rpManifest(true));
    withFlag.set('Craftmatic_RP/textures/entity/craftmatic_swatch_4.texture_set.json', textureSet([201, 7, 44]));
    const pbr = await readAppearancePbrMaterials(withFlag, new Map());
    const pbrAppearance = buildAddonAppearance(withFlag, pbr);
    const red = pbrAppearance.byType.get('craftmatic:b_shell')!.groups[0]!;
    expect(red.surface).toEqual({ metalness: 201 / 255, emissive: 7 / 255, roughness: 44 / 255, source: 'texture-set-inline' });
    expect(pbrAppearance.byType.get('craftmatic:b_shell')!.groups[1]!.surface).toBeUndefined();
    expect(pbrAppearance.notes.join(' ')).toMatch(/swatch_2.*classic diffuse fallback/);

    const withoutFlag = new Map(withFlag);
    withoutFlag.set('Craftmatic_RP/manifest.json', rpManifest(false));
    const classic = await readAppearancePbrMaterials(withoutFlag, new Map());
    expect(classic.enabled).toBe(false);
    expect(buildAddonAppearance(withoutFlag, classic).byType.get('craftmatic:b_shell')!.groups[0]!.surface).toBeUndefined();

    const malformed = new Map(withFlag);
    malformed.set('Craftmatic_RP/textures/entity/craftmatic_swatch_4.texture_set.json', textureSet([256, 0, 0]));
    const rejected = await readAppearancePbrMaterials(malformed, new Map());
    expect(rejected.byTexture.has('textures/entity/craftmatic_swatch_4')).toBe(false);
    expect(rejected.notes.join(' ')).toMatch(/no supported uniform MER/);
  });

  it('decodes edited uniform RGB8/RGBA8 MER pixels without treating them as sRGB', async () => {
    const input = sources();
    input.set('Craftmatic_RP/manifest.json', rpManifest(true));
    input.set('Craftmatic_RP/textures/entity/craftmatic_swatch_4.texture_set.json', textureSet('edited_mer'));
    const pngs = new Map([['Craftmatic_RP/textures/entity/edited_mer.png', uniformPng([17, 91, 233])]]);
    const pbr = await readAppearancePbrMaterials(input, pngs);
    expect(pbr.byTexture.get('textures/entity/craftmatic_swatch_4')).toEqual({
      metalness: 17 / 255, emissive: 91 / 255, roughness: 233 / 255, source: 'texture-set-mer-png',
    });
  });

  it('reports missing, corrupt and non-uniform MER assets and uses no guessed surface', async () => {
    const input = sources();
    input.set('Craftmatic_RP/manifest.json', rpManifest(true));
    input.set('Craftmatic_RP/textures/entity/craftmatic_swatch_4.texture_set.json', textureSet('bad_mer'));
    input.set('Craftmatic_RP/textures/entity/craftmatic_swatch_2.texture_set.json', textureSet('varied_mer'));
    const varied = new Uint8Array(2 * 1 * 4);
    varied.set([0, 0, 92, 255, 1, 0, 92, 255]);
    const crcBroken = uniformPng([0, 0, 92]);
    crcBroken[45] = crcBroken[45]! ^ 1;
    const pbr = await readAppearancePbrMaterials(input, new Map([
      ['Craftmatic_RP/textures/entity/bad_mer.png', crcBroken],
      ['Craftmatic_RP/textures/entity/varied_mer.png', encodePngRgba(2, 1, varied)],
    ]));
    expect(pbr.byTexture.size).toBe(0);
    expect(pbr.notes.join(' ')).toMatch(/unsupported or corrupt/);
    expect(pbr.notes.join(' ')).toMatch(/invalid CRC/);
    expect(pbr.notes.join(' ')).toMatch(/non-uniform/);
    const app = buildAddonAppearance(input, pbr);
    expect(app.byType.get('craftmatic:b_shell')!.groups.every(g => g.surface === undefined)).toBe(true);
    expect(app.notes.join(' ')).toMatch(/classic diffuse fallback/);
  });

  it('maps actual surfaces to Standard materials and classic fallback to Lambert without tinting a face atlas', () => {
    const surface = { metalness: 0.8, emissive: 0.25, roughness: 0.1, source: 'texture-set-inline' as const };
    const pbr = addonAppearanceMaterial({ colorHex: 0x123456, alpha: 0.5, surface }) as THREE.MeshStandardMaterial;
    expect(pbr.isMeshStandardMaterial).toBe(true);
    expect([pbr.metalness, pbr.roughness, pbr.emissiveIntensity, pbr.transparent, pbr.opacity]).toEqual([0.8, 0.1, 0.25, true, 0.5]);
    expect(pbr.emissive.getHex()).toBe(0x123456);
    const classic = addonAppearanceMaterial({ colorHex: 0x123456, alpha: 1 }) as THREE.MeshLambertMaterial;
    expect(classic.isMeshLambertMaterial).toBe(true);
    const faintClassic = addonAppearanceMaterial({ colorHex: 0x123456, alpha: 0.1 }) as THREE.MeshLambertMaterial;
    const faintPbr = addonAppearanceMaterial({ colorHex: 0x123456, alpha: 0.1, surface }) as THREE.MeshStandardMaterial;
    expect([faintClassic.opacity, faintPbr.opacity]).toEqual([0.1, 0.1]);
    const atlas = new THREE.Texture();
    const face = addonAppearanceMaterial({ colorHex: 0xb0b8c4, alpha: 1, surface }, atlas) as THREE.MeshStandardMaterial;
    expect(face.color.getHex()).toBe(0xffffff);
    expect(face.map).toBe(atlas);
    expect(face.emissiveMap).toBe(atlas);
    expect(face.alphaTest).toBe(0.5);
    expect(face.side).toBe(THREE.DoubleSide);
  });
});

describe('faceDecalGeometry', () => {
  it('winds every vertical face out of its cube', () => {
    const expected = {
      north: new THREE.Vector3(0, 0, -1), south: new THREE.Vector3(0, 0, 1),
      east: new THREE.Vector3(1, 0, 0), west: new THREE.Vector3(-1, 0, 0),
    } as const;
    for (const face of Object.keys(expected) as Array<keyof typeof expected>) {
      const geometry = faceDecalGeometry({ width: 8, height: 8 }, [{
        bone: 'body', origin: [1, 2, 3], size: [4, 5, 6],
        faceUv: { face, uv: [0, 0], size: [8, 8] },
      }], new Map());
      expect(geometry, face).not.toBeNull();
      const p = geometry!.getAttribute('position');
      const a = new THREE.Vector3().fromBufferAttribute(p, 0);
      const b = new THREE.Vector3().fromBufferAttribute(p, 1);
      const c = new THREE.Vector3().fromBufferAttribute(p, 2);
      const windingNormal = b.sub(a).cross(c.sub(a)).normalize();
      expect(windingNormal.dot(expected[face]), face).toBeCloseTo(1, 6);
    }
  });

  it('transforms a north-face normal outward through the preview holder Z mirror', () => {
    const geometry = faceDecalGeometry({ width: 8, height: 8 }, [{
      bone: 'body', origin: [0, 0, 0], size: [4, 5, 6],
      faceUv: { face: 'north', uv: [0, 0], size: [8, 8] },
    }], new Map())!;
    const holder = new THREE.Matrix4().makeScale(1, 1, -1);
    expect(holder.determinant()).toBeLessThan(0);
    const local = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('normal'), 0);
    const world = local.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(holder));
    expect(world.toArray()).toEqual([0, 0, 1]);
  });
});

describe('swatchColorId', () => {
  it('reads the LDraw colour a swatch is named for', () => {
    expect(swatchColorId('textures/entity/craftmatic_swatch_47')).toBe(47);
    expect(swatchColorId('textures/entity/craftmatic_swatch_0')).toBe(0);
    expect(swatchColorId('textures/entity/something_else')).toBeNull();
  });
});

describe('buildAddonAppearance', () => {
  it('groups cubes by the colour their controller binds', () => {
    const app = buildAddonAppearance(sources());
    const entry = app.byType.get('craftmatic:b_shell');
    expect(entry).toBeDefined();
    expect(entry!.cubeCount).toBe(3);
    expect(entry!.groups).toHaveLength(2);

    // mesh_0 -> Texture.default -> swatch 4 (red); mesh_1 -> swatch 2 (green).
    const [red, green] = entry!.groups;
    expect(red!.ldrawColor).toBe(4);
    expect(green!.ldrawColor).toBe(2);
    const four = resolveLdrawEntityMaterial(4);
    expect(red!.colorHex).toBe((four.rgb[0] << 16) | (four.rgb[1] << 8) | four.rgb[2]);
    expect(red!.cubes).toHaveLength(2);
    expect(green!.cubes).toHaveLength(1);
  });

  it('takes the NEAR geometry from a distance-switched controller', () => {
    // `Array.g[query.distance_from_camera > D]` is 0 when close, so index 0 —
    // never `Geometry.empty`, which would draw nothing and look like a pack
    // that ships no model.
    const entry = buildAddonAppearance(sources()).byType.get('craftmatic:b_shell')!;
    expect(entry.groups[0]!.cubes.map(c => c.size)).toContainEqual([16, 8, 16]);
  });

  it('keeps each cube on its bone, with the bone parent chain intact', () => {
    const entry = buildAddonAppearance(sources()).byType.get('craftmatic:b_shell')!;
    const rotated = entry.groups[1]!.cubes[0]!;
    expect(rotated.bone).toBe('r7');
    const bone = entry.bones.find(b => b.name === 'r7');
    expect(bone?.parent).toBe('body');
    expect(bone?.rotation).toEqual([0, 90, 0]);
  });

  it('keeps a cube\'s own rotation, which is what a stud facet carries', () => {
    const entry = buildAddonAppearance(sources()).byType.get('craftmatic:b_shell')!;
    const facet = entry.groups[0]!.cubes.find(c => c.rotation);
    expect(facet?.rotation).toEqual([0, 45, 0]);
    expect(facet?.pivot).toEqual([20, 4, 4]);
  });

  it('reports a controller it cannot resolve instead of dropping it silently', () => {
    const missing = sources();
    missing.set('Craftmatic_RP/render_controllers/shell.render_controllers.json', JSON.stringify({ render_controllers: {} }));
    const app = buildAddonAppearance(missing);
    expect(app.byType.size).toBe(0);
    expect(app.notes.join(' ')).toContain('not in the pack');
  });

  it('draws an entity whose controller is one MINECRAFT ships', () => {
    // A seat names `controller.render.default`, which is vanilla and must NOT
    // be in the pack. Treating it as missing reported every correct pack as
    // broken and drew nothing, which is the failure this preview exists to
    // catch rather than to cause.
    const vanilla = sources();
    vanilla.set('Craftmatic_BP/entity/seat.entity.json', JSON.stringify({
      'minecraft:client_entity': {
        description: {
          identifier: 'craftmatic:s_seat',
          geometry: { default: 'geometry.craftmatic.shell_mesh_0' },
          textures: { default: 'textures/entity/craftmatic_swatch_4' },
          render_controllers: ['controller.render.default'],
        },
      },
    }));
    const app = buildAddonAppearance(vanilla);
    const seat = app.byType.get('craftmatic:s_seat');
    expect(seat, app.notes.join(' | ')).toBeDefined();
    expect(seat!.groups[0]!.cubes.length).toBeGreaterThan(0);
    expect(app.notes.join(' ')).not.toContain('controller.render.default');
  });

  it('survives a malformed file by noting it', () => {
    const broken = sources();
    broken.set('Craftmatic_RP/models/entity/shell.geo.json', '{ not json');
    const app = buildAddonAppearance(broken);
    expect(app.notes.some(n => n.includes('not valid JSON'))).toBe(true);
  });
});

describe('face decals (head-face.ts): a real texture, one face per cube', () => {
  it('keeps the atlas path and size and each decal cube\'s one textured face', () => {
    const faceEntity = JSON.stringify({ 'minecraft:client_entity': { description: {
      identifier: 'craftmatic:f_fig1',
      geometry: { mesh_0: 'geometry.craftmatic.fig1_mesh_0' },
      textures: { default: 'textures/entity/f_fig1_faces' },
      render_controllers: ['controller.render.craftmatic.fig1_mesh_0'],
    } } });
    const faceControllers = JSON.stringify({ render_controllers: { 'controller.render.craftmatic.fig1_mesh_0': {
      geometry: 'Geometry.mesh_0', materials: [{ '*': 'Material.cutout' }], textures: ['Texture.default'],
    } } });
    const faceGeo = JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{
      description: { identifier: 'geometry.craftmatic.fig1_mesh_0', texture_width: 112, texture_height: 96 },
      bones: [{ name: 'head', pivot: [0, 24, 0], cubes: [
        { origin: [-2, 24, -2.2], size: [4.2, 3.8, 0.1], uv: { north: { uv: [0, 0], uv_size: [104, 96] } } },
      ] }],
    }] });
    const a = buildAddonAppearance(new Map([
      ['RP/entity/f.entity.json', faceEntity],
      ['RP/render_controllers/f.render_controllers.json', faceControllers],
      ['RP/models/entity/f.geo.json', faceGeo],
    ]));
    const group = a.byType.get('craftmatic:f_fig1')!.groups[0]!;
    expect(group.texture).toEqual({ path: 'textures/entity/f_fig1_faces', width: 112, height: 96 });
    expect(group.cubes[0]!.faceUv).toEqual({ face: 'north', uv: [0, 0], size: [104, 96] });
  });

  it('leaves an ordinary swatch group untextured', () => {
    const a = buildAddonAppearance(sources());
    expect(a.byType.get('craftmatic:b_shell')!.groups.every(g => g.texture === undefined && g.cubes.every(c => c.faceUv === undefined))).toBe(true);
  });
});
