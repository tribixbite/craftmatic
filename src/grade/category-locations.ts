/**
 * category-locations.ts — Shared building location configs for multi-category grading.
 *
 * 31 buildings from iterate-grade.ts (10 old + 10 new + coit) plus
 * 10 new architecturally-diverse locations selected for category scoring.
 *
 * Each config has coords, known dimensions, and descriptive metadata.
 * GLB paths are optional — not all locations have pre-captured models.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CategoryLocation {
  /** Unique identifier (lowercase, no spaces) */
  key: string;
  /** Human-readable building name */
  name: string;
  /** City and state */
  city: string;
  /** "lat,lng" string */
  coords: string;
  /** Approximate building footprint extent (longest side, meters) */
  extentM?: number;
  /** Satellite zoom override (computed from extent if absent) */
  satZoom?: number;
  /** GLB model path (if pre-captured) */
  glb?: string;
  /** Resolution for voxelization (1 or 2) */
  resolution: number;
  /** OSM mask dilation */
  maskDilate: number;
  /** Explicit OSM element ID */
  osmId?: string;
  /** Extra voxelizer flags */
  extraFlags: string[];
  /** Scene mode — include environment (roads, trees, paths) */
  sceneMode: boolean;
  /** Architectural category for diversity tracking */
  archType: string;
  /** Street View FOV override (default: 110 for extentM>30, else 90) */
  svFov?: number;
  /** Alternate coords for SV lookup only (doesn't affect OSM masking) */
  svCoords?: string;
}

// ─── Existing 21 locations (from iterate-grade.ts) ──────────────────────────

const DIR = 'output/tiles';

export const LOCATIONS_OLD: CategoryLocation[] = [
  {
    key: 'flatiron', name: 'Flatiron Building', city: 'New York, NY',
    coords: '40.7411,-73.9897', extentM: 25,
    glb: `${DIR}/tiles-flatiron-building-new-york-ny.glb`,
    resolution: 2, maskDilate: 1, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'triangular',
  },
  {
    key: 'pennzoil', name: 'Pennzoil Place', city: 'Houston, TX',
    coords: '29.7538,-95.3675', extentM: 90,
    glb: `${DIR}/pennzoil-v200.glb`,
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'twin-towers',
  },
  {
    key: 'nga-east', name: 'National Gallery of Art East Building', city: 'Washington, DC',
    coords: '38.8913,-77.0199', extentM: 80,
    glb: `${DIR}/national-gallery-east.glb`,
    // osmId way/66418590 causes 100% removal (wrong polygon) — use auto-detect with dilate=2
    // building-colour sandstone: Tennessee Pink Marble is beige/sandy, not glass curtain wall
    resolution: 1, maskDilate: 2,
    extraFlags: ['--no-enu', '--recolor', '--building-colour', 'sandstone'],
    sceneMode: false, archType: 'trapezoidal',
  },
  {
    key: 'dallas-cityhall', name: 'Dallas City Hall', city: 'Dallas, TX',
    coords: '32.7763,-96.7968', extentM: 60,
    glb: `${DIR}/dallas-cityhall.glb`,
    resolution: 1, maskDilate: 1, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'inverted-pyramid',
  },
  {
    key: 'seattle-library', name: 'Seattle Central Library', city: 'Seattle, WA',
    coords: '47.6067,-122.3326', extentM: 70,
    glb: `${DIR}/seattle-library.glb`,
    resolution: 1, maskDilate: 1, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'faceted-glass',
  },
  {
    key: 'boston-cityhall', name: 'Boston City Hall', city: 'Boston, MA',
    coords: '42.3605,-71.0580', extentM: 60,
    glb: `${DIR}/boston-cityhall.glb`,
    // svCoords: west side approach avoids Faneuil Hall red brick in SV frame
    // svFov: narrowed from 110 to 60 to focus on building face, not surroundings
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'brutalist',
    svCoords: '42.3605,-71.0595', svFov: 60,
  },
  {
    key: 'citigroup', name: 'Citigroup Center', city: 'New York, NY',
    coords: '40.7585,-73.9703', extentM: 49,
    glb: `${DIR}/citigroup-v200.glb`,
    resolution: 1, maskDilate: 1, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'sloped-crown',
  },
  {
    key: 'geisel', name: 'Geisel Library', city: 'San Diego, CA',
    coords: '32.8811,-117.2376', extentM: 30,
    glb: `${DIR}/geisel-v200.glb`,
    resolution: 2, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'brutalist-mushroom',
  },
  {
    key: 'transamerica', name: 'Transamerica Pyramid', city: 'San Francisco, CA',
    coords: '37.7952,-122.4028', extentM: 40,
    glb: `${DIR}/transamerica-v200b.glb`,
    // --force-recolor + --building-colour: photogrammetry bakes dark AO+glass reflections;
    // actual building is white quartz — bypass height heuristic that defaults to "glass curtain wall"
    resolution: 1, maskDilate: 0, extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'ivory'],
    sceneMode: false, archType: 'pyramidal',
  },
  {
    key: 'la-cityhall', name: 'Los Angeles City Hall', city: 'Los Angeles, CA',
    coords: '34.0522,-118.2437', extentM: 60,
    glb: `${DIR}/la-cityhall.glb`,
    resolution: 1, maskDilate: 1, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'art-deco-tower',
  },
];

export const LOCATIONS_NEW: CategoryLocation[] = [
  {
    key: 'marina-city', name: 'Marina City', city: 'Chicago, IL',
    coords: '41.8887,-87.6355', extentM: 40,
    glb: `${DIR}/marina-city.glb`,
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'cylindrical',
  },
  {
    key: 'hearst-tower', name: 'Hearst Tower', city: 'New York, NY',
    coords: '40.7666,-73.9810', extentM: 50,
    glb: `${DIR}/hearst-tower.glb`,
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'diagrid',
  },
  {
    key: 'guggenheim', name: 'Guggenheim Museum', city: 'New York, NY',
    coords: '40.7830,-73.9590', extentM: 30,
    glb: `${DIR}/guggenheim.glb`,
    resolution: 2, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'spiral-rotunda',
  },
  {
    key: 'fbi-hq', name: 'J. Edgar Hoover Building', city: 'Washington, DC',
    coords: '38.8948,-77.0247', extentM: 100,
    glb: `${DIR}/fbi-hq.glb`,
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'brutalist-slab',
  },
  {
    key: 'mopop', name: 'Museum of Pop Culture', city: 'Seattle, WA',
    coords: '47.6215,-122.3481', extentM: 40,
    glb: `${DIR}/mopop.glb`,
    resolution: 2, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'organic-blob',
  },
  {
    key: 'natl-cathedral', name: 'Washington National Cathedral', city: 'Washington, DC',
    coords: '38.9306,-77.0707', extentM: 100,
    glb: `${DIR}/natl-cathedral.glb`,
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'gothic-cathedral',
  },
  {
    key: 'boa-tower', name: 'Bank of America Tower', city: 'New York, NY',
    coords: '40.7555,-73.9848', extentM: 50,
    glb: `${DIR}/boa-tower.glb`,
    resolution: 1, maskDilate: 1, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'crystalline-crown',
  },
  {
    key: 'tribune-tower', name: 'Tribune Tower', city: 'Chicago, IL',
    coords: '41.8903,-87.6233', extentM: 40,
    glb: `${DIR}/tribune-tower.glb`,
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'neo-gothic',
  },
  {
    key: 'vessel-nyc', name: 'The Vessel', city: 'New York, NY',
    coords: '40.7536,-74.0022', extentM: 20,
    glb: `${DIR}/vessel-nyc.glb`,
    resolution: 2, maskDilate: 1, extraFlags: ['--no-enu'],
    sceneMode: false, archType: 'honeycomb',
  },
  {
    key: 'disney-hall', name: 'Walt Disney Concert Hall', city: 'Los Angeles, CA',
    coords: '34.0553,-118.2498', extentM: 60,
    glb: `${DIR}/disney-hall.glb`,
    resolution: 2, maskDilate: 0, osmId: 'relation/6333150',
    extraFlags: ['--no-enu'], sceneMode: false, archType: 'deconstructivist',
  },
  {
    key: 'coit-grandrapids', name: 'Coit Creative Arts Academy', city: 'Grand Rapids, MI',
    coords: '42.9742448,-85.6653327', extentM: 50,
    glb: `${DIR}/coit-grandrapids.glb`,
    resolution: 1, maskDilate: 1, osmId: 'way/223060418',
    extraFlags: ['--no-enu'], sceneMode: false, archType: 'institutional',
  },
];

// ─── 10 new diverse locations for expanded category grading ─────────────────
// Chosen for architectural diversity: cantilevers, curves, stacking, spires,
// glass, concrete, stadiums, towers, low-rise, domes.

export const LOCATIONS_EXTRA: CategoryLocation[] = [
  {
    // Cantilevered over waterfall — organic/stone, Frank Lloyd Wright
    key: 'fallingwater', name: 'Fallingwater', city: 'Mill Run, PA',
    coords: '39.9064,-79.4680', extentM: 25,
    resolution: 2, maskDilate: 2, extraFlags: [],
    sceneMode: true, archType: 'cantilever-organic',
  },
  {
    // 192m stainless steel catenary arch — Eero Saarinen, 1965
    key: 'gateway-arch', name: 'Gateway Arch', city: 'St. Louis, MO',
    coords: '38.6247,-90.1848', extentM: 60,
    resolution: 1, maskDilate: 1, extraFlags: [],
    sceneMode: true, archType: 'arch-monument',
  },
  {
    // Stacked modular concrete cubes — Moshe Safdie, 1967
    key: 'habitat67', name: 'Habitat 67', city: 'Montreal, QC',
    coords: '45.4978,-73.5434', extentM: 80,
    resolution: 1, maskDilate: 2, extraFlags: [],
    sceneMode: false, archType: 'modular-stacked',
  },
  {
    // Art deco spire + eagles — William Van Alen, 1930
    key: 'chrysler', name: 'Chrysler Building', city: 'New York, NY',
    coords: '40.7516,-73.9755', extentM: 40,
    resolution: 1, maskDilate: 1, extraFlags: [],
    sceneMode: false, archType: 'art-deco-spire',
  },
  {
    // Glass + timber frame chapel — E. Fay Jones, 1980
    key: 'thorncrown', name: 'Thorncrown Chapel', city: 'Eureka Springs, AR',
    coords: '36.4192,-93.7381', extentM: 15,
    resolution: 2, maskDilate: 2, extraFlags: [],
    sceneMode: true, archType: 'glass-chapel',
  },
  {
    // Symmetrical concrete courts — Louis Kahn, 1965
    key: 'salk-institute', name: 'Salk Institute', city: 'La Jolla, CA',
    coords: '32.8884,-117.2463', extentM: 80,
    resolution: 1, maskDilate: 2, extraFlags: [],
    sceneMode: false, archType: 'brutalist-symmetric',
  },
  {
    // Historic stadium, irregular footprint — 1914/1926
    key: 'wrigley-field', name: 'Wrigley Field', city: 'Chicago, IL',
    coords: '41.9484,-87.6553', extentM: 130,
    resolution: 1, maskDilate: 2, extraFlags: [],
    sceneMode: false, archType: 'stadium',
  },
  {
    // Thin tower + disc observation deck — 184m, 1962
    key: 'space-needle', name: 'Space Needle', city: 'Seattle, WA',
    coords: '47.6205,-122.3493', extentM: 25,
    resolution: 2, maskDilate: 1, extraFlags: [],
    sceneMode: true, archType: 'tower-disc',
  },
  {
    // Low-rise modernist desert house — Richard Neutra, 1946
    key: 'kaufmann-house', name: 'Kaufmann Desert House', city: 'Palm Springs, CA',
    coords: '33.8338,-116.5462', extentM: 30,
    resolution: 2, maskDilate: 2, extraFlags: [],
    sceneMode: true, archType: 'modernist-low-rise',
  },
  {
    // Beaux-Arts dome + granite — 1915
    key: 'sf-cityhall', name: 'San Francisco City Hall', city: 'San Francisco, CA',
    coords: '37.7793,-122.4193', extentM: 100,
    resolution: 1, maskDilate: 1, extraFlags: [],
    sceneMode: false, archType: 'beaux-arts-dome',
  },
];

/** All 31 locations combined */
export const ALL_LOCATIONS: CategoryLocation[] = [
  ...LOCATIONS_OLD,
  ...LOCATIONS_NEW,
  ...LOCATIONS_EXTRA,
];

/** Group names for CLI filtering */
export type LocationGroup = 'old' | 'new' | 'extra' | 'all';

/** Get locations by group name */
export function getLocationsByGroup(group: LocationGroup): CategoryLocation[] {
  switch (group) {
    case 'old': return LOCATIONS_OLD;
    case 'new': return LOCATIONS_NEW;
    case 'extra': return LOCATIONS_EXTRA;
    case 'all': return ALL_LOCATIONS;
  }
}
