/**
 * The brick separator is a tool from the box, not model content
 * (web/src/engine/build-tools.ts): LEGO's digital instructions place one beside
 * the finished model (877 placements in 868 DbixConvV3 files), and exported it
 * lay on the grass outside 10788's dollhouse (user shot, round 30i).
 */
import { describe, expect, it } from 'vitest';
import { BUILD_TOOL_PARTS, isBuildTool, withoutBuildTools } from '../web/src/engine/build-tools.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

describe('build tools', () => {
  it('knows every brick separator by its mould id, in any placed spelling', () => {
    expect([...BUILD_TOOL_PARTS].sort()).toEqual(['4654', '630', '96874']);
    for (const part of ['96874.dat', 'parts/630.dat', '4654.DAT', '10788 - 96874.dat', 'parts\\96874.dat']) expect(isBuildTool(part)).toBe(true);
    // A part that merely shares digits is not one.
    for (const part of ['6300.dat', '96874p01x.dat', '3001.dat', '46540.dat']) expect(isBuildTool(part)).toBe(false);
  });

  it('removes only the separators and keeps the same array when there is none', () => {
    const model: ParsedBrick[] = [{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }, { part: '3003.dat', color: 1, x: 40, y: 0, z: 0 }];
    const same = withoutBuildTools(model);
    expect(same.removed).toBe(0);
    expect(same.bricks).toBe(model);
    const withTool = [...model, { part: '96874.dat', color: 25, x: -450, y: -24, z: -60 }];
    const r = withoutBuildTools(withTool);
    expect(r.removed).toBe(1);
    expect(r.bricks.map(b => b.part)).toEqual(['3001.dat', '3003.dat']);
  });

  it('leaves a separator out of the voxel grid, so it neither draws nor widens the footprint', async () => {
    const model: ParsedBrick[] = [{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }];
    // 20 stud-widths away: with it the grid would span the gap.
    const withTool: ParsedBrick[] = [...model, { part: '96874.dat', color: 25, x: 400, y: -24, z: 0 }];
    const run = (bricks: ParsedBrick[]) => runSchemPipeline({ source: { kind: 'bricks', bricks, colorSpace: 'ldraw', options: { cellLDU: 20, maxDim: 700 } }, format: 'guide', profile: 'java' } as Parameters<typeof runSchemPipeline>[0]);
    // Control: a real brick at the separator's spot does widen it.
    const withBrick: ParsedBrick[] = [...model, { part: '3001.dat', color: 25, x: 400, y: -24, z: 0 }];
    const [plain, tooled, bricked] = await Promise.all([run(model), run(withTool), run(withBrick)]);
    expect(bricked.grid.width).toBeGreaterThan(plain.grid.width + 10);
    expect(tooled.grid.width).toBe(plain.grid.width);
    expect(tooled.nonAir).toBe(plain.nonAir);
  });
});
