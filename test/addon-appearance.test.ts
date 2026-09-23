import { describe, expect, it } from 'vitest';
import { APPEARANCE_FILE_PATTERN, buildAddonAppearance, swatchColorId } from '../web/src/ui/addon-appearance.js';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';

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
    expect(APPEARANCE_FILE_PATTERN.test('X_BP/scripts/placement.js')).toBe(false);
    expect(APPEARANCE_FILE_PATTERN.test('X_RP/textures/entity/craftmatic_swatch_4.png')).toBe(false);
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

  it('survives a malformed file by noting it', () => {
    const broken = sources();
    broken.set('Craftmatic_RP/models/entity/shell.geo.json', '{ not json');
    const app = buildAddonAppearance(broken);
    expect(app.notes.some(n => n.includes('not valid JSON'))).toBe(true);
  });
});
