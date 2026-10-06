import { describe, expect, it } from 'vitest';
import type { LdrawPartMesh, LdrawTriangle, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import { compilePartPrototype, resolveEntityQuality, type CompiledPartPrototype, type PartCuboid } from '../web/src/engine/ldraw-part-prototype.js';
import { facetScale, fitRoundProfile, roundFacetBoxes, roundFacetIoU, selectRoundFacetCandidate } from '../web/src/engine/ldraw-round-facets.js';

/**
 * A cylinder voxelised on an axis-aligned lattice reads as a square up close
 * and no grain fixes it. `fitRoundProfile` decides whether a part may instead
 * be drawn as boxes fanned about its axis, and it must be STRICT: measured,
 * the construction beats the lattice on a genuine cylinder (3062b: 44 cuboids
 * at IoU 0.931 against 4 at 0.947) and collapses on a compound part (24869
 * Wheels: 100 at 0.866 against 4 at 0.629). Letting a compound part through
 * would wreck it. `fitRoundProfile` remains an outer-envelope profiler; the
 * selector below supplies the production-safe replacement decision.
 */

const tri = (a: Vec3, b: Vec3, c: Vec3): LdrawTriangle => ({ a, b, c, color: 16 });
const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): LdrawTriangle[] => [tri(a, b, c), tri(a, c, d)];

function meshOf(partId: string, triangles: LdrawTriangle[]): LdrawPartMesh {
  const xs = triangles.flatMap(t => [t.a[0], t.b[0], t.c[0]]);
  const ys = triangles.flatMap(t => [t.a[1], t.b[1], t.c[1]]);
  const zs = triangles.flatMap(t => [t.a[2], t.b[2], t.c[2]]);
  return {
    partId, resolvedAs: partId, triangles, studs: [], unresolvedRefs: [], description: '',
    bounds: { min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] },
  };
}

/** A closed cylinder of radius `r` from y0 to y1, turning about Y. */
function cylinderY(r: number, y0: number, y1: number, segments = 32, cx = 0, cz = 0): LdrawTriangle[] {
  const out: LdrawTriangle[] = [];
  const p = (k: number, y: number): Vec3 => {
    const a = k / segments * Math.PI * 2;
    return [cx + r * Math.cos(a), y, cz + r * Math.sin(a)];
  };
  for (let k = 0; k < segments; k++) {
    out.push(...quad(p(k, y0), p(k + 1, y0), p(k + 1, y1), p(k, y1)));
    out.push(tri([cx, y0, cz], p(k, y0), p(k + 1, y0)));
    out.push(tri([cx, y1, cz], p(k + 1, y1), p(k, y1)));
  }
  return out;
}

/** An open-top tube: production's top/side flood must preserve its central air. */
function openTubeY(outer: number, inner: number, y0: number, y1: number, segments = 32): LdrawTriangle[] {
  const out: LdrawTriangle[] = [];
  const p = (r: number, k: number, y: number): Vec3 => {
    const a = k / segments * Math.PI * 2;
    return [r * Math.cos(a), y, r * Math.sin(a)];
  };
  for (let k = 0; k < segments; k++) {
    out.push(...quad(p(outer, k, y0), p(outer, k + 1, y0), p(outer, k + 1, y1), p(outer, k, y1)));
    out.push(...quad(p(inner, k, y0), p(inner, k, y1), p(inner, k + 1, y1), p(inner, k + 1, y0)));
    out.push(...quad(p(inner, k, y1), p(inner, k + 1, y1), p(outer, k + 1, y1), p(outer, k, y1)));
  }
  return out;
}

const prototypeOf = (mesh: LdrawPartMesh, hollow = false): CompiledPartPrototype =>
  compilePartPrototype(mesh, resolveEntityQuality({ microcellLdu: 2 }), { hollow, decomposition: 'best-of' });

function boxTris(min: Vec3, max: Vec3): LdrawTriangle[] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  return [
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),
    ...quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)),
    ...quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)),
    ...quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0)),
  ];
}

describe('fitRoundProfile', () => {
  it('fits a plain cylinder on its own axis', () => {
    const profile = fitRoundProfile(meshOf('cyl', cylinderY(10, 0, 20)), 2);
    expect(profile).not.toBeNull();
    expect(profile!.axis).toBe(1);
    expect(profile!.radiusLdu).toBeCloseTo(10, 1);
    expect(profile!.loLdu).toBeCloseTo(0, 1);
    expect(profile!.hiLdu).toBeCloseTo(20, 1);
  });

  it('fits a cylinder lying along X', () => {
    const along: LdrawTriangle[] = cylinderY(10, 0, 40).map(t => ({
      ...t,
      a: [t.a[1], t.a[0], t.a[2]] as Vec3, b: [t.b[1], t.b[0], t.b[2]] as Vec3, c: [t.c[1], t.c[0], t.c[2]] as Vec3,
    }));
    expect(fitRoundProfile(meshOf('cylx', along), 2)?.axis).toBe(0);
  });

  it('refuses a box, which is what keeps ordinary bricks on the lattice', () => {
    expect(fitRoundProfile(meshOf('brick', boxTris([-40, 0, -20], [40, 24, 20])), 2)).toBeNull();
    // Even a SQUARE-footprint box, whose cross-axis extents match a disc's.
    expect(fitRoundProfile(meshOf('cube', boxTris([-10, 0, -10], [10, 20, 10])), 2)).toBeNull();
  });

  it('refuses a flanged cylinder — a wider section breaks the disc', () => {
    // A shaft with a base plate: this is the antenna case, where the lattice
    // scores 0.911 and four facets only 0.600.
    const flanged = [...cylinderY(6, 0, 40), ...cylinderY(12, 40, 48)];
    expect(fitRoundProfile(meshOf('antenna', flanged), 2)).toBeNull();
  });

  it('refuses two rims on an axle — the coaster wheel case', () => {
    const wheel = [...cylinderY(14, 0, 6), ...cylinderY(5, 6, 30), ...cylinderY(14, 30, 36)];
    expect(fitRoundProfile(meshOf('wheel', wheel), 2)).toBeNull();
  });

  it('accepts a hollow tube: only the outer boundary is a silhouette', () => {
    const tube = [...cylinderY(10, 0, 20), ...cylinderY(6, 0, 20)];
    expect(fitRoundProfile(meshOf('tube', tube), 2)).not.toBeNull();
  });

  it('refuses a disc too small to be worth fanning', () => {
    expect(fitRoundProfile(meshOf('pin', cylinderY(3, 0, 12)), 2)).toBeNull();
  });
});

describe('roundFacetBoxes', () => {
  it('emits one box per facet, fanned over 180 degrees about the axis', () => {
    const profile = fitRoundProfile(meshOf('cyl', cylinderY(10, 0, 20)), 2)!;
    const boxes = roundFacetBoxes(profile, 4);
    expect(boxes).toHaveLength(4);
    expect(boxes.map(b => b.rotationDeg)).toEqual([0, 45, 90, 135]);
    // Every box spans the profile's full extent along its axis.
    for (const b of boxes) {
      expect(b.min[1]).toBeCloseTo(profile.loLdu, 5);
      expect(b.max[1]).toBeCloseTo(profile.hiLdu, 5);
    }
  });

  it('beats the square peg it replaces, and more facets read rounder', () => {
    const mesh = meshOf('cyl', cylinderY(10, 0, 20));
    const profile = fitRoundProfile(mesh, 2)!;
    const one = roundFacetIoU(mesh, profile, 1);
    const four = roundFacetIoU(mesh, profile, 4);
    const six = roundFacetIoU(mesh, profile, 6);
    expect(four).toBeGreaterThan(one);
    expect(six).toBeGreaterThanOrEqual(four);
    // Four facets is a 16-sided outline; it should be close to the circle.
    expect(four).toBeGreaterThan(0.9);
  });

  it('grows the fan past corners-on-circle, by the measured scale', () => {
    // Measured over four round moulds: inscribing the polygon loses area to the
    // conservatively rasterised reference, so the optimum sits above 1.
    expect(facetScale(4)).toBeGreaterThan(1);
    expect(facetScale(6)).toBeGreaterThan(1);
    expect(facetScale(6)).toBeLessThan(facetScale(4));
    const mesh = meshOf('cyl', cylinderY(10, 0, 20));
    const profile = fitRoundProfile(mesh, 2)!;
    expect(roundFacetIoU(mesh, profile, 4)).toBeGreaterThan(0.9);
  });
});

describe('selectRoundFacetCandidate', () => {
  it('accepts a cheaper solid cylinder and leaves the source mesh and prototype unchanged', () => {
    const mesh = meshOf('solid-cylinder', cylinderY(10, 0, 20));
    const prototype = prototypeOf(mesh);
    const meshBefore = structuredClone(mesh);
    const prototypeBefore = structuredClone(prototype);

    const decision = selectRoundFacetCandidate(mesh, prototype, { facets: 4 });

    expect(decision.accepted).toBe(true);
    if (decision.accepted) {
      expect(decision.measurement!.cuboidsSaved).toBeGreaterThan(0);
      expect(decision.measurement!.candidateViewIoU.every((value, view) => value >= decision.measurement!.sourceViewIoU[view]!)).toBe(true);
      expect(decision.measurement!.candidateViewIoU.some((value, view) => value > decision.measurement!.sourceViewIoU[view]!)).toBe(true);
    }
    expect(mesh).toEqual(meshBefore);
    expect(prototype).toEqual(prototypeBefore);
  });

  it('rejects hollow and open-stud geometry whose production fill preserves interior air', () => {
    const mesh = meshOf('open-stud', openTubeY(10, 5, 0, 20));
    const decision = selectRoundFacetCandidate(mesh, prototypeOf(mesh), { facets: 4 });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain('preserved-interior-air');

    const transparent = selectRoundFacetCandidate(meshOf('glass', cylinderY(10, 0, 20)), prototypeOf(meshOf('glass', cylinderY(10, 0, 20)), true), { facets: 4 });
    expect(transparent.reasons).toContain('transparent-prototype');
  });

  it('rejects a notched round outline before candidate scoring', () => {
    const triangles = cylinderY(10, 0, 20);
    triangles.splice(0, 2); // remove one outer-wall sector while leaving the end caps
    const mesh = meshOf('notched', triangles);
    const decision = selectRoundFacetCandidate(mesh, prototypeOf(mesh), { facets: 4 });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain('preserved-interior-air');
  });

  it('rejects explicit print colour, print fallback, and surface-preserving prototypes', () => {
    const mesh = meshOf('printed', cylinderY(10, 0, 20));
    mesh.triangles[0] = { ...mesh.triangles[0]!, color: 4 };
    mesh.printFallback = 'printed';
    const decision = selectRoundFacetCandidate(mesh, prototypeOf(mesh), { facets: 4, preserveSurface: true });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'explicit-triangle-colour', 'print-fallback', 'surface-preserving-prototype',
    ]));
  });

  it('rejects a candidate whose improved mean hides a regression in an end view', () => {
    const mesh = meshOf('per-view-regression', cylinderY(10, 0, 20));
    const strips: PartCuboid[] = Array.from({ length: 40 }, (_, row) => {
      const z0 = -10 + row / 2, z1 = z0 + 0.5;
      const halfWidth = Math.sqrt(100 - ((z0 + z1) / 2) ** 2);
      return { min: [-halfWidth, 5, z0], max: [halfWidth, 15, z1], color: 16 };
    });
    const prototype: CompiledPartPrototype = { ...prototypeOf(mesh), cuboids: strips };
    const decision = selectRoundFacetCandidate(mesh, prototype, { facets: 4 });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain('silhouette-view-regression');
    expect(decision.measurement).toBeDefined();
    const sourceMean = decision.measurement!.sourceViewIoU.reduce((a, b) => a + b) / 6;
    const candidateMean = decision.measurement!.candidateViewIoU.reduce((a, b) => a + b) / 6;
    expect(candidateMean).toBeGreaterThan(sourceMean);
  });
});
