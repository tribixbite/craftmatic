import type { ParsedBrick } from './ldraw-parser.js';

export type VehicleMode = 'auto' | 'car' | 'plane' | 'static';
export type PlayableKind = 'car' | 'plane';

export interface PlayableBrickComponent {
  id: string;
  label: string;
  kind: PlayableKind;
  bricks: ParsedBrick[];
  /** Why this exact subset, rather than the complete set, was selected. */
  provenance: string;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

const CAR_WORDS = /\b(car|truck|bus|buggy|racer|roadster|batmobile|vehicle|tractor|loader|motorcycle|bike|kart)\b/i;
const PLANE_WORDS = /\b(plane|airplane|aeroplane|jet|aircraft|starfighter|fighter|helicopter|copter|spaceship|shuttle)\b/i;
const SCENERY_WORDS = /\b(garage|airport|hangar|museum|station|batcave|shadowbox|shadow box|workshop|city|showroom)\b/i;
export const isWholeVehicleLabel = (label: string): boolean => !SCENERY_WORDS.test(label) && (CAR_WORDS.test(label) || PLANE_WORDS.test(label));
// Small/medium road wheels used by the verified 76252 source and common System cars.
const ROAD_WHEELS = new Set(['55982', '58090', '30027', '30028', '11208', '11209', '18976', '18977', '30391']);

const stem = (part: string) => part.replace(/^.*[/\\]/, '').replace(/\.dat$/i, '').toLowerCase();

/** The source's first assembly is the complete 399-part Batmobile. Match every
 * placement (including its transform), not just the set number or a box around
 * its wheels: that old crop lost 112 car parts and captured 52 scenery parts. */
function verifiedBatmobile(bricks: ParsedBrick[]): ParsedBrick[] | null {
  if (bricks.length <= 399) return null;
  const car = bricks.slice(0, 399);
  const signature = JSON.stringify(car.map(b => [b.part, b.color, b.x, b.y, b.z, b.rot]));
  let hash = 2166136261;
  for (let i = 0; i < signature.length; i++) hash = Math.imul(hash ^ signature.charCodeAt(i), 16777619);
  return (hash >>> 0) === 0x1001363b ? car : null;
}

export function classifyVehicleKind(label: string, mode: VehicleMode): PlayableKind | null {
  if (mode === 'car' || mode === 'plane') return mode;
  if (mode === 'static') return null;
  if (/\b76252\b|batcave shadow/i.test(label)) return 'car';
  if (PLANE_WORDS.test(label)) return 'plane';
  if (CAR_WORDS.test(label)) return 'car';
  return null;
}

/**
 * Find independently named MPD submodels first.  This is the strongest
 * provenance: it prevents a vehicle contained in a building from taking the
 * building with it when driven.
 */
function namedSubmodels(bricks: ParsedBrick[], kind: PlayableKind): ParsedBrick[][] {
  const re = kind === 'car' ? CAR_WORDS : PLANE_WORDS;
  const groups = new Map<string, ParsedBrick[]>();
  for (const brick of bricks) {
    const path = brick.sourcePath ?? [];
    let matched: string | undefined;
    for (let i = path.length - 1; i >= 0; i--) if (re.test(path[i]!)) { matched = path[i]; break; }
    if (!matched) continue;
    const key = [...path.slice(0, path.lastIndexOf(matched) + 1)].join('/');
    const group = groups.get(key) ?? [];
    group.push(brick); groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.length >= 8 && group.length < bricks.length * 0.8);
}

/**
 * A wheel-seeded spatial component for flattened sources.  Bounds come from
 * actual wheel placements and use LDraw units (20/stud, 8/plate).  Requiring
 * four wheels and keeping only their local envelope avoids the catastrophic
 * failure mode where 76252's complete Batcave becomes the rideable entity.
 */
function wheelComponents(bricks: ParsedBrick[]): ParsedBrick[][] {
  const wheels = bricks.filter(b => ROAD_WHEELS.has(stem(b.part)));
  if (wheels.length < 4) return [];
  const clusters: ParsedBrick[][] = [];
  for (const wheel of wheels) {
    let cluster = clusters.find(c => c.some(w => Math.hypot(w.x - wheel.x, w.y - wheel.y, w.z - wheel.z) < 420));
    if (!cluster) { cluster = []; clusters.push(cluster); }
    cluster.push(wheel);
  }
  // Join transitively adjacent wheel clusters.
  for (let i = clusters.length - 1; i > 0; i--) for (let j = 0; j < i; j++) {
    if (clusters[i]!.some(a => clusters[j]!.some(b => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z) < 420))) {
      clusters[j]!.push(...clusters[i]!); clusters.splice(i, 1); break;
    }
  }
  return clusters.filter(c => c.length >= 4).map(c => {
    const xs = c.map(b => b.x), ys = c.map(b => b.y), zs = c.map(b => b.z);
    const x0 = Math.min(...xs) - 40, x1 = Math.max(...xs) + 40;
    const y0 = Math.min(...ys) - 80, y1 = Math.max(...ys) + 80;
    const z0 = Math.min(...zs) - 40, z1 = Math.max(...zs) + 40;
    return bricks.filter(b => b.x >= x0 && b.x <= x1 && b.y >= y0 && b.y <= y1 && b.z >= z0 && b.z <= z1);
  }).filter(selected => selected.length >= 20 && selected.length < bricks.length * 0.65);
}

export function discoverPlayableComponents(
  bricks: ParsedBrick[], label: string, mode: VehicleMode = 'auto',
): { components: PlayableBrickComponent[]; warnings: string[] } {
  const kind = classifyVehicleKind(label, mode);
  if (!kind) return { components: [], warnings: [] };
  const withBounds = (component: Omit<PlayableBrickComponent, 'bounds'>): PlayableBrickComponent => {
    const xs=component.bricks.map(b=>b.x), ys=component.bricks.map(b=>b.y), zs=component.bricks.map(b=>b.z);
    return {...component,bounds:{min:[Math.min(...xs),Math.min(...ys),Math.min(...zs)],max:[Math.max(...xs),Math.max(...ys),Math.max(...zs)]}};
  };

  if (/\b76252\b|batcave shadow/i.test(label) && kind === 'car') {
    const car = verifiedBatmobile(bricks);
    if (car) return {
      components: [withBounds({ id: 'batmobile', label: 'Batmobile', kind: 'car', bricks: car,
        provenance: 'verified complete 399-part Mecabricks Batmobile assembly' })], warnings: [],
    };
  }

  const named = namedSubmodels(bricks, kind);
  if (named.length) return {
    components: named.map((group, i) => withBounds({ id: `${kind}_${i + 1}`, label, kind, bricks: group, provenance: 'named MPD submodel ancestry' })),
    warnings: [],
  };

  if (kind === 'car' && !/\b76252\b|batcave shadow/i.test(label)) {
    const wheeled = wheelComponents(bricks);
    if (wheeled.length) return {
      components: wheeled.map((group, i) => withBounds({
        id: /76252/.test(label) ? 'batmobile' : `car_${i + 1}`,
        label: /76252|batcave/i.test(label) ? 'Batmobile' : label,
        kind, bricks: group,
        provenance: 'four-wheel spatial component from flattened LDraw source',
      })),
      warnings: [],
    };
  }

  // A source whose title itself is a vehicle is safe to make wholly rideable.
  // Container builds (for example 76252) must never take this route.
  if (mode === 'auto' && isWholeVehicleLabel(label)) return {
    components: [withBounds({ id: kind, label, kind, bricks, provenance: 'whole model identified by source title' })], warnings: [],
  };

  // An explicit override means the user really did choose the whole model.
  if (mode === kind) return {
    components: [withBounds({ id: kind, label, kind, bricks, provenance: 'explicit whole-model vehicle override' })],
    warnings: [],
  };
  return {
    components: [],
    warnings: [`Could not isolate a ${kind} component; exported the build without inventing a movable subset.`],
  };
}

/** Exact, measured interaction anchors for the verified flattened 76252 model. */
export function knownScreenAnchors(setLabel: string): Array<{ id: string; label: string; ldraw: [number, number, number] }> {
  if (!/\b76252\b|batcave shadow/i.test(setLabel)) return [];
  return [
    { id: 'batcomputer_left', label: 'Batcomputer — systems', ldraw: [220, -526, 72] },
    { id: 'batcomputer_right', label: 'Batcomputer — security', ldraw: [400, -526, 72] },
  ];
}
