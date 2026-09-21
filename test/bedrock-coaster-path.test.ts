import { describe, expect, it } from 'vitest';
import { advanceCoasterRoute, buildCoasterFrames, buildCoasterPath, createCoasterRoute, sampleCoasterPath, sampleCoasterRoute, stitchCoasterTrackFragments } from '../web/src/engine/coaster-path.js';

describe('coaster route sampling', () => {
  const route = createCoasterRoute({
    kind: 'closed', maxSegmentLength: 10,
    // A vertical-capable square; the final point makes the closing section explicit.
    points: [[0, 0, 0], [3, 0, 0], [3, 4, 0], [0, 4, 0], [0, 0, 0]],
  });

  it('uses cumulative arc length rather than segment index and preserves vertical tangents', () => {
    expect(route.length).toBe(14);
    expect(sampleCoasterRoute(route, 5)).toMatchObject({ position: [3, 2, 0], tangent: [0, 1, 0], segmentIndex: 1 });
    expect(sampleCoasterRoute(route, 19)).toMatchObject({ position: [3, 2, 0], tangent: [0, 1, 0] });
  });

  it('supports reverse traversal without changing the authored path', () => {
    const reversed = sampleCoasterRoute(route, 5, -1);
    expect(reversed.position).toEqual([3, 2, 0]);
    expect(Math.abs(reversed.tangent[0])).toBe(0);
    expect(reversed.tangent[1]).toBe(-1);
    expect(Math.abs(reversed.tangent[2])).toBe(0);
    const runtimePath = buildCoasterPath(route.points, true, 10);
    const serializedReversed = sampleCoasterPath(runtimePath, -5);
    expect(serializedReversed.position).toEqual([1, 4, 0]);
    expect(serializedReversed.tangent[0]).toBe(1);
    expect(Math.abs(serializedReversed.tangent[1])).toBe(0);
    expect(Math.abs(serializedReversed.tangent[2])).toBe(0);
    expect(advanceCoasterRoute(route, 13, 3, 1)).toEqual({ distance: 2, reachedEnd: false });
  });

  it('wraps a closed route exactly at its explicit seam with the initial tangent', () => {
    const loop = buildCoasterPath([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 0, 0]], true, 3);
    expect(loop.length).toBeCloseTo(2 + 2 + Math.sqrt(8));
    expect(sampleCoasterPath(loop, loop.length).position).toEqual([0, 0, 0]);
    expect(sampleCoasterPath(loop, loop.length).tangent).toEqual([1, 0, 0]);
    expect(sampleCoasterPath(loop, loop.length + 1).position).toEqual([1, 0, 0]);
  });

  it('rejects corrupt serialized path data rather than generating NaN coordinates', () => {
    const valid = buildCoasterPath([[0, 0, 0], [2, 0, 0]], false, 2);
    expect(() => sampleCoasterPath({ ...valid, cumulative: [0, 99] }, 1)).toThrow('cumulative');
    expect(() => sampleCoasterPath({ ...valid, points: [[0, 0, 0], [Number.NaN, 0, 0]] }, 1)).toThrow('invalid');
    expect(() => sampleCoasterPath({ ...valid, points: [[0, 0, 0], [0, 0, 0]] }, 1)).toThrow('inconsistent');
    // The pack embeds this function with Function#toString: it must not rely
    // on module helpers/constants that do not exist in the Bedrock script.
    const embedded = new Function(`return (${sampleCoasterPath.toString()});`)() as typeof sampleCoasterPath;
    expect(embedded(valid, 1)).toMatchObject({ position: [1, 0, 0], tangent: [1, 0, 0] });
  });

  it('requires an explicit closed seam and rejects unbounded or degenerate gaps', () => {
    expect(() => createCoasterRoute({ kind: 'closed', maxSegmentLength: 10, points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] })).toThrow('explicitly repeat');
    expect(() => createCoasterRoute({ kind: 'open', maxSegmentLength: 2, points: [[0, 0, 0], [3, 0, 0]] })).toThrow('exceeding maxSegmentLength');
    expect(() => createCoasterRoute({ kind: 'open', maxSegmentLength: 2, points: [[0, 0, 0], [0, 0, 0]] })).toThrow('zero length');
    expect(() => createCoasterRoute({ kind: 'open', maxSegmentLength: 2, points: [[Number.NaN, 0, 0], [1, 0, 0]] })).toThrow('finite');
    expect(() => buildCoasterPath([[0, 0, 0], [3, 0, 0]], false, 2)).toThrow('exceeding maxSegmentLength');
  });

  it('stops at open endpoints until a caller explicitly reverses a shuttle', () => {
    const lift = createCoasterRoute({ kind: 'open', maxSegmentLength: 10, points: [[0, 0, 0], [0, 8, 0]] });
    expect(advanceCoasterRoute(lift, 6, 5)).toEqual({ distance: 8, reachedEnd: true });
    expect(advanceCoasterRoute(lift, 8, 5, -1)).toEqual({ distance: 3, reachedEnd: false });
    const reversed = advanceCoasterRoute(lift, 8, 5, -1);
    expect(sampleCoasterRoute(lift, reversed.distance, -1).position).toEqual([0, 3, 0]);
    expect(sampleCoasterRoute(lift, 5)).toMatchObject({ position: [0, 5, 0], tangent: [0, 1, 0] });
  });

  it('keeps disconnected track pieces, reports gaps, and never picks a nearest branch', () => {
    const graph = stitchCoasterTrackFragments([
      { id: 'a', samples: [[0, 0, 0], [10, 0, 0]] },
      { id: 'b', samples: [[10.2, 0, 0], [20, 0, 0]] },
      { id: 'far', samples: [[50, 0, 0], [60, 0, 0]] },
    ], { endpointToleranceLdu: 1, minTangentDot: .99 });
    expect(graph.connections).toHaveLength(1);
    expect(graph.components).toEqual([['a', 'b'], ['far']]);
    expect(graph.gaps).toEqual(['a:start', 'b:end', 'far:end', 'far:start']);
    const ambiguous = stitchCoasterTrackFragments([
      { id: 'a', samples: [[0, 0, 0], [10, 0, 0]] },
      { id: 'b', samples: [[10.1, 0, 0], [20, 0, 0]] },
      { id: 'c', samples: [[10.2, 0, 0], [20, 0, 0]] },
    ], { endpointToleranceLdu: 1, minTangentDot: .99 });
    expect(ambiguous.connections).toEqual([]);
    expect(ambiguous.ambiguous).toContain('a:end');
    const wrongOrientation = stitchCoasterTrackFragments([
      { id: 'a', samples: [[0, 0, 0], [10, 0, 0]] },
      // Both outward endpoint tangents point +X, so they overlap but are not a physical join.
      { id: 'b', samples: [[10.1, 0, 0], [0, 0, 0]] },
    ], { endpointToleranceLdu: 1, minTangentDot: .99 });
    expect(wrongOrientation.connections).toEqual([]);
    expect(wrongOrientation.gaps).toContain('a:end');
  });
});

describe('coaster parallel-transport frames', () => {
  const expectUnitOrthogonal = (up: readonly number[], tangent: readonly number[]): void => {
    expect(Math.hypot(...up)).toBeCloseTo(1, 8);
    expect(up[0]! * tangent[0]! + up[1]! * tangent[1]! + up[2]! * tangent[2]!).toBeCloseTo(0, 8);
  };

  it('rolls down at a vertical-loop apex and returns up at the closed seam', () => {
    const steps = 64;
    const points = Array.from({ length: steps + 1 }, (_, index) => {
      const angle = index / steps * Math.PI * 2;
      return [Math.sin(angle), 1 - Math.cos(angle), 0] as const;
    });
    points[steps] = points[0]!;
    const path = buildCoasterPath(points, true, .2);
    const frames = buildCoasterFrames(path);
    expect(frames).toHaveLength(points.length);
    expect(frames[0]![1]).toBeGreaterThan(.99);
    expect(frames[steps / 2]![1]).toBeLessThan(-.99);
    expect(frames.at(-1)).toEqual(frames[0]);
    for (let index = 0; index < frames.length; index++) {
      const before = points[index === 0 ? steps - 1 : index - 1]!, after = points[index === steps ? 1 : index + 1]!;
      const length = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
      expectUnitOrthogonal(frames[index]!, [(after[0] - before[0]) / length, (after[1] - before[1]) / length, 0]);
    }
  });

  it('keeps world up through a horizontal curve and is orientation-consistent when reversed', () => {
    const points = [[0, 0, 0], [1, 0, 1], [2, 0, 1], [3, 0, 0]] as const;
    const forward = buildCoasterFrames(buildCoasterPath(points, false, 2));
    expect(forward.every(up => Math.abs(up[0]) < 1e-9 && up[1] === 1 && Math.abs(up[2]) < 1e-9)).toBe(true);
    const reversed = buildCoasterFrames(buildCoasterPath([...points].reverse(), false, 2));
    reversed.reverse().forEach((up, index) => {
      expect(up[0]).toBeCloseTo(forward[index]![0], 8);
      expect(up[1]).toBeCloseTo(forward[index]![1], 8);
      expect(up[2]).toBeCloseTo(forward[index]![2], 8);
    });
  });

  it('chooses a finite fallback at a vertical start and preserves roll at an exact 180-degree cusp', () => {
    const vertical = buildCoasterPath([[0, 0, 0], [0, 1, 0], [0, 2, 1]], false, 2);
    const verticalFrames = buildCoasterFrames(vertical);
    expectUnitOrthogonal(verticalFrames[0]!, [0, 1, 0]);
    expect(verticalFrames[0]!.every(Number.isFinite)).toBe(true);

    const cusp = buildCoasterPath([[0, 0, 0], [1, 0, 0], [0, 0, 0]], false, 2);
    const cuspFrames = buildCoasterFrames(cusp);
    expect(cuspFrames).toEqual([[0, 1, 0], [0, 1, 0], [0, 1, 0]]);
  });

  it('validates serialized paths and remains dependency-free when embedded', () => {
    const path = buildCoasterPath([[0, 0, 0], [2, 0, 0]], false, 2);
    expect(() => buildCoasterFrames({ ...path, cumulative: [0, 99] })).toThrow('end at total length');
    expect(() => buildCoasterFrames(path, [0, Number.NaN, 0])).toThrow('finite');
    const embedded = new Function(`return (${buildCoasterFrames.toString()});`)() as typeof buildCoasterFrames;
    expect(embedded(path)).toEqual([[0, 1, 0], [0, 1, 0]]);
  });
});
