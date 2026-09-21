import { describe, expect, it } from 'vitest';
import { advanceCoasterRoute, buildCoasterPath, createCoasterRoute, sampleCoasterPath, sampleCoasterRoute, stitchCoasterTrackFragments } from '../web/src/engine/coaster-path.js';

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
