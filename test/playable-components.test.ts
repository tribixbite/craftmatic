import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLDraw, type ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { discoverPlayableComponents } from '../web/src/engine/playable-components.js';
import { alignVoxelGrid } from '../web/src/engine/schem-pipeline.js';
import { BlockGrid } from '../src/schem/types.js';

const fixture = () => parseLDraw(readFileSync(new URL('./fixtures/batcave-car-assembly.ldr', import.meta.url), 'utf8'));

describe('Batcave movable assembly', () => {
  it('keeps the entire actual car including nose and tail, excluding the scenery assembly', () => {
    const bricks = fixture();
    const { components } = discoverPlayableComponents(bricks, 'Batcave 76252');
    expect(bricks).toHaveLength(400);
    expect(components).toHaveLength(1);
    expect(components[0]!.bricks).toEqual(bricks.slice(0, 399));
    expect(components[0]!.bounds!.min[0]).toBe(-48);
    expect(components[0]!.bounds!.max[0]).toBe(540);
    expect(components[0]!.longitudinalAxis).toBe('x');
    expect(components[0]!.forwardDirection).toBe('+x');
    expect(components[0]!.seatAnchor).toEqual({ x: .456, y: .42, z: .5 });
    expect(components[0]!.bricks).not.toContain(bricks[399]);
  });

  it('recognizes the 10300 DeLorean time machine as a whole-model car', () => {
    const brick = fixture()[0]!;
    const result = discoverPlayableComponents([brick], '10300 Back to the Future Time Machine');
    expect(result.components).toHaveLength(1);
    expect(result.components[0]!.kind).toBe('car');
    expect(result.components[0]!.bricks).toEqual([brick]);
  });

  it('keeps the entire standalone Technic car instead of cropping around wheels', () => {
    const bricks = fixture().slice(0, 399);
    for (const label of ['Ferrari Daytona SP3', 'McLaren P1', 'Porsche 911 GT3 RS']) {
      const result = discoverPlayableComponents(bricks, label);
      expect(result.components).toHaveLength(1);
      expect(result.components[0]!.bricks).toEqual(bricks);
    }
  });

  it('does not apply a known-source crop to a different source with the same set number', () => {
    const bricks = fixture();
    bricks[0] = { ...bricks[0]!, x: 999 };
    const result = discoverPlayableComponents(bricks, 'Batcave 76252');
    expect(result.components).toHaveLength(0);
    expect(result.warnings).not.toHaveLength(0);
  });

  it('aligns separately rebuilt scenery when its origin and resolution differ', () => {
    const source = new BlockGrid(4, 1, 1);
    source.set(0, 0, 0, 'minecraft:stone');
    source.set(2, 0, 0, 'minecraft:gold_block');
    const frame = { x: 0, y: 0, z: 0, scale: .5, cellXZ: 4, cellY: 4 };
    const result = alignVoxelGrid(source, { ...frame, x: 4, scale: 1 }, frame, new BlockGrid(6, 1, 1));
    expect(result.get(2, 0, 0)).toBe('minecraft:stone');
    expect(result.get(3, 0, 0)).toBe('minecraft:gold_block');
    expect(result.countNonAir()).toBe(2);
    expect(result.get(0, 0, 0)).toBe('minecraft:air');
  });
});

describe('vehicle-titled MPD with a display beside the vehicle', () => {
  const row = (n: number, x0 = 0): ParsedBrick[] => Array.from({ length: n }, (_, i) => ({ part: '3001.dat', color: 4, x: x0 + i * 80, y: 0, z: 0 }));

  it('prefers a dominant vehicle-named submodel over its siblings and says what it left out', () => {
    const car = row(20).map(b => ({ ...b, sourcePath: ['75892 - main.ldr', '75892 - car.ldr'] }));
    const tunnel = row(5, 20000).map(b => ({ ...b, sourcePath: ['75892 - main.ldr', '75892 - wind tunnel.ldr'] }));
    const pilot = row(3, 40000).map(b => ({ ...b, sourcePath: ['75892 - main.ldr', '75892 - pilot.ldr'] }));
    const { components, warnings } = discoverPlayableComponents([...car, ...tunnel, ...pilot], 'McLaren Senna (75892)');
    expect(components[0]!.bricks).toHaveLength(20);
    expect(components[0]!.provenance).toContain('vehicle submodel "75892 - car"');
    expect(warnings[0]).toContain('8 placements outside');
  });

  it('does not trust a vehicle-named submodel that holds less than half the model', () => {
    const body = row(6).map(b => ({ ...b, sourcePath: ['main.ldr', 'car body.ldr'] }));
    const chassis = row(14, 0).map(b => ({ ...b, y: -24, sourcePath: ['main.ldr', 'chassis.ldr'] }));
    const { components } = discoverPlayableComponents([...body, ...chassis], 'Speed Champions Racer');
    expect(components[0]!.bricks).toHaveLength(20);
  });
});
