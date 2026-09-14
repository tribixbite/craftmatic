import { describe, it, expect } from 'vitest';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

describe('compileLdrawEntityGeometry', () => {
  it('compiles parsed LDraw bricks directly to Bedrock geometry with bones and cubes', () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, // 2x4 red brick
      { part: '3004.dat', color: 1, x: 20, y: -24, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, // 1x2 blue brick
    ];

    const result = compileLdrawEntityGeometry('test_car', 'car', bricks);
    expect(result).toBeDefined();
    expect(result.meshIds.length).toBeGreaterThan(0);
    expect(result.palette.length).toBeGreaterThan(0);
    expect(result.seatPosition).toBeDefined();
    expect(result.collisionBox.width).toBeGreaterThan(0);
  });

  it('separates transparent canopy and windshield parts into a dedicated transparent mesh', () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 0, x: 0, y: 0, z: 0 },
      { part: '84954.dat', color: 47, x: 0, y: -48, z: 40 }, // curved canopy windscreen (trans-clear)
    ];

    const result = compileLdrawEntityGeometry('milano', 'plane', bricks);
    expect(result.canopyMeshId).toBe('geometry.craftmatic.milano_canopy');
    expect(result.meshIds).toContain('geometry.craftmatic.milano_canopy');
    // Cockpit seat is positioned behind/under the canopy, not at [0, 0, 0]
    expect(result.seatPosition[1]).toBeGreaterThan(0);
  });

  it('emits rotated bones with Euler angles for angled parts', () => {
    const bricks: ParsedBrick[] = [
      // Wing part angled at ~45 degrees
      {
        part: '3001.dat',
        color: 14,
        x: 100,
        y: -50,
        z: 100,
        rot: [0.707, 0, 0.707, 0, 1, 0, -0.707, 0, 0.707],
      },
    ];

    const result = compileLdrawEntityGeometry('fighter', 'plane', bricks);
    const geo = result.value as any;
    const mesh = geo['minecraft:geometry'][0];
    const bone = mesh.bones[0];
    expect(bone.rotation).toBeDefined();
    expect(Math.abs(bone.rotation[1])).toBeCloseTo(45, 0);
  });
  it('integrates with buildPlayableAddon emitting canopy mesh and true cockpit seat', async () => {
    const { BlockGrid } = await import('@craft/schem/types.js');
    const { buildPlayableAddon } = await import('../web/src/engine/playable-addon.js');
    const grid = new BlockGrid(10, 10, 10);
    grid.set(5, 1, 5, 'minecraft:blue_concrete');

    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 1, x: 0, y: 0, z: 0 },
      { part: '84954.dat', color: 47, x: 0, y: -48, z: 40 },
    ];

    const addon = await buildPlayableAddon(grid, {
      stem: 'test_plane',
      components: [
        {
          id: 'plane_0',
          label: 'Test Plane',
          kind: 'plane',
          grid,
          provenance: 'test',
          bricks,
        },
      ],
    });

    expect(addon.bytes).toBeDefined();
    // Verify zip contains the compiled entity and canopy assets
    const { unzipSync } = await import('fflate');
    const unzipped = unzipSync(addon.bytes);
    const filenames = Object.keys(unzipped);
    expect(filenames.some(f => f.includes('models/entity/test_plane_plane_0.geo.json'))).toBe(true);
    expect(filenames.some(f => f.includes('entity/test_plane_plane_0.entity.json'))).toBe(true);
    expect(filenames.some(f => f.includes('textures/entity/test_plane_plane_0_canopy.png'))).toBe(true);

    // Check entity JSON has canopy material
    const clientEntityFile = filenames.find(f => f.includes('entity/test_plane_plane_0.entity.json'))!;
    const clientEntityJson = JSON.parse(new TextDecoder().decode(unzipped[clientEntityFile]));
    expect(clientEntityJson['minecraft:client_entity'].description.materials.canopy).toBe('entity_alphablend');

    // Check behavior JSON has seat inside cockpit
    const behaviorFile = filenames.find(f => f.includes('entities/test_plane_plane_0.json'))!;
    const behaviorJson = JSON.parse(new TextDecoder().decode(unzipped[behaviorFile]));
    const seatPos = behaviorJson['minecraft:entity'].components['minecraft:rideable'].seats.position;
    expect(seatPos).toBeDefined();
    expect(seatPos[1]).toBeGreaterThan(0);
  });

  it('assigns studFace to exposed bricks, tileFace to tiles/slopes/covered bricks, and grilleFace to grilles', () => {
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }, // 2x4 red brick (bottom)
      { part: '3001.dat', color: 1, x: 0, y: -24, z: 0 }, // 2x4 blue brick (top, covering the bottom brick!)
      { part: '3068.dat', color: 0, x: 100, y: 0, z: 0 }, // 2x2 tile (smooth top)
      { part: '2412b.dat', color: 71, x: 200, y: 0, z: 0 }, // 1x2 grille tile (vent slits)
    ];

    const result = compileLdrawEntityGeometry('test_details', 'car', bricks);
    const geo = result.value as any;
    const mesh = geo['minecraft:geometry'][0];
    expect(mesh.description.texture_width).toBe(64);

    const cubes = mesh.bones[0].cubes;
    expect(cubes.length).toBe(4);

    // Cube 0: 3001 (bottom, covered by Cube 1) -> should have tileFace (u=32), NOT studFace (u=0)
    const cubeBottom = cubes[0];
    expect(cubeBottom.uv.up.uv[0]).toBe(32);

    // Cube 1: 3001 (top, exposed) -> should have studFace (u=0)
    const cubeTop = cubes[1];
    expect(cubeTop.uv.up.uv[0]).toBe(0);

    // Cube 2: 3068 tile -> should have tileFace (u=32)
    const cubeTile = cubes[2];
    expect(cubeTile.uv.up.uv[0]).toBe(32);

    // Cube 3: 2412b grille -> should have grilleFace (u=48)
    const cubeGrille = cubes[3];
    expect(cubeGrille.uv.up.uv[0]).toBe(48);

    // All vertical faces (north, south, east, west) must strictly use sideFace (u=16, no studs on walls)
    for (const c of cubes) {
      expect(c.uv.north.uv[0]).toBe(16);
      expect(c.uv.south.uv[0]).toBe(16);
      expect(c.uv.east.uv[0]).toBe(16);
      expect(c.uv.west.uv[0]).toBe(16);
      expect(c.uv.down.uv[0]).toBe(16);
    }
  });
});
