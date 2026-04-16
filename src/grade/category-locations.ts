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
}

// ─── Existing 21 locations (from iterate-grade.ts) ──────────────────────────

const DIR = 'output/tiles';

export const LOCATIONS_OLD: CategoryLocation[] = [
  {
    key: 'flatiron', name: 'Flatiron Building', city: 'New York, NY',
    // r=2 needed for triangular layout recognition (features=9, layout=10)
    // --recolor: r=2 photogrammetry texture noise collapses colors to 3 without it
    coords: '40.7411,-73.9897', extentM: 25,
    glb: `${DIR}/tiles-flatiron-building-new-york-ny.glb`,
    resolution: 2, maskDilate: 1, extraFlags: ['--no-enu', '--recolor'],
    sceneMode: false, archType: 'triangular',
  },
  {
    key: 'pennzoil', name: 'Pennzoil Place', city: 'Houston, TX',
    // 29.7538,-95.3675 was ~700m off; 29.7601,-95.3698 showed Houston City Hall (too far west)
    // Nominatim confirms Pennzoil Place at 29.7601,-95.3656 (Rusk St, Downtown Houston)
    // osmId way/580965929 = exact Pennzoil Place footprint (clips neighboring buildings)
    // --recolor: photogrammetry captures gray AO; actual building is dark bronze glass curtain wall
    // pennzoil-new2.glb: re-captured Apr 16 at correct coords 29.7601,-95.3656 with --height 172 (2 bands)
    // OSM building:colour=#52503C (dark bronze glass curtain wall) — correct!
    // --fill: sparse 3D tiles mesh needs interior fill to produce solid twin-tower blocks
    // OSM fallback (api.openstreetmap.org) used when Overpass is down
    coords: '29.7601,-95.3656', extentM: 90,
    glb: `${DIR}/pennzoil-new2.glb`,
    resolution: 1, maskDilate: 1, osmId: 'way/580965929',
    extraFlags: ['--no-enu', '--recolor', '--fill'],
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
    // osmId avoided: way/27129838 clips exterior walls (inner courtyard only)
    // PLATEAU: tilted-face overhang bands not captured in 3D tiles mesh at facade resolution
    resolution: 1, maskDilate: 1,
    extraFlags: ['--no-enu'],
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
    // OSM building:colour=#888A99 (gray-blue); SV shows warm tan/beige in sunlight → force tan
    // maskDilate=8: cantilevered upper floors overhang ~5-8m beyond ground footprint
    resolution: 1, maskDilate: 8, osmId: 'way/788015166',
    extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'tan'],
    sceneMode: false, archType: 'brutalist',
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
    // way/159385495 = exact Geisel Library footprint (octagonal brutalist-mushroom)
    // GLB captures 161x152m of UCSD campus; explicit osmId clips to just the 30m building
    // --force-recolor ivory: photogrammetry bakes dark AO; actual building is pale concrete
    // --no-satellite-roof: satellite captures dark inner roof, not the pale outer steps
    resolution: 2, maskDilate: 0, osmId: 'way/159385495',
    extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'ivory', '--no-satellite-roof'],
    sceneMode: false, archType: 'brutalist-mushroom',
  },
  {
    key: 'transamerica', name: 'Transamerica Pyramid', city: 'San Francisco, CA',
    coords: '37.7952,-122.4028', extentM: 40,
    glb: `${DIR}/transamerica-v200b.glb`,
    // --force-recolor + --building-colour: photogrammetry bakes dark AO+glass reflections;
    // actual building is white quartz — bypass height heuristic that defaults to "glass curtain wall"
    // maskDilate=2: wings on N+S faces extend ~2m beyond pyramid footprint
    resolution: 1, maskDilate: 2,
    extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'ivory'],
    sceneMode: false, archType: 'pyramidal',
  },
  {
    key: 'la-cityhall', name: 'Los Angeles City Hall', city: 'Los Angeles, CA',
    // 34.0522,-118.2437 was ~165m south; OSM relation/6333145 centroid is 34.0537,-118.2428
    // --recolor (not force): replaces GRAY_FAMILY only → preserves facade texture for features score
    // OSM native building:colour=#e0d6ca (warm off-white) used — do NOT override with white (too stark)
    // --roof-colour terracotta: direct palette inject for 4 wing roofs (bypasses satellite dark-courtyard gray guard)
    coords: '34.0537,-118.2428', extentM: 60,
    glb: `${DIR}/la-cityhall.glb`,
    resolution: 1, maskDilate: 1, osmId: 'relation/6333145',
    extraFlags: ['--no-enu', '--recolor', '--roof-colour', 'terracotta'],
    sceneMode: false, archType: 'art-deco-tower',
  },
];

export const LOCATIONS_NEW: CategoryLocation[] = [
  {
    key: 'marina-city', name: 'Marina City', city: 'Chicago, IL',
    coords: '41.8887,-87.6355', extentM: 40,
    glb: `${DIR}/marina-city.glb`,
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu', '--recolor'],
    sceneMode: false, archType: 'cylindrical',
  },
  {
    key: 'hearst-tower', name: 'Hearst Tower', city: 'New York, NY',
    coords: '40.7666,-73.9810', extentM: 50,
    glb: `${DIR}/hearst-tower.glb`,
    // --no-enu required: without it the GLB captures adjacent buildings sideways (382-block span)
    // No osmId: way/23617584 clips too aggressively and removes tower geometry
    resolution: 1, maskDilate: 2,
    extraFlags: ['--no-enu', '--recolor'],
    sceneMode: false, archType: 'diagrid',
  },
  {
    key: 'guggenheim', name: 'Guggenheim Museum', city: 'New York, NY',
    // osmId=way/170149134 CLIPS ALL geometry — do NOT use
    // Auto SV positioning: cameras offset N/S/E/W from center at viewDistM, aimed at center.
    // This avoids the "shot from inside building" problem of the old center-based approach.
    coords: '40.7830,-73.9590', extentM: 40,
    glb: `${DIR}/guggenheim.glb`,
    resolution: 2, maskDilate: 2,
    extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'white'],
    sceneMode: false, archType: 'spiral-rotunda',
  },
  {
    key: 'fbi-hq', name: 'J. Edgar Hoover Building', city: 'Washington, DC',
    coords: '38.8948,-77.0247', extentM: 100,
    glb: `${DIR}/fbi-hq.glb`,
    // --force-recolor --building-colour tan: FBI HQ is poured concrete (warm beige/tan)
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'tan'],
    sceneMode: false, archType: 'brutalist-slab',
  },
  {
    key: 'mopop', name: 'Museum of Pop Culture', city: 'Seattle, WA',
    coords: '47.6215,-122.3481', extentM: 40,
    glb: `${DIR}/mopop.glb`,
    // r=2: needed for complex blob shapes; MoPOP is multi-colored metallic (blue/silver/purple sections)
    // --force-recolor blue: most dominant facade color (cobalt blue metallic panels)
    // --recolor alone hits gray guard (OSM has no colour tag)
    resolution: 2, maskDilate: 2, extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'blue'],
    sceneMode: false, archType: 'organic-blob',
  },
  {
    key: 'natl-cathedral', name: 'Washington National Cathedral', city: 'Washington, DC',
    coords: '38.9306,-77.0707', extentM: 100,
    glb: `${DIR}/natl-cathedral.glb`,
    // osmId=relation/2682714: clips to cathedral only, removes surrounding tree noise
    // --force-recolor --building-colour buff: Indiana limestone (warm cream-gray stone exterior)
    // NOTE: 'gray' hits gray-family guard and is skipped — must use buff/beige instead
    resolution: 1, maskDilate: 2, osmId: 'relation/2682714',
    extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'buff'],
    sceneMode: false, archType: 'gothic-cathedral',
  },
  {
    key: 'boa-tower', name: 'Bank of America Tower', city: 'New York, NY',
    coords: '40.7555,-73.9848', extentM: 50,
    glb: `${DIR}/boa-tower.glb`,
    // --recolor: use SV-derived palette (low-iron blue glass curtain wall)
    // --force-recolor blue produced dark navy checkerboard (light_blue_terracotta gamma=0.4)
    resolution: 1, maskDilate: 1, extraFlags: ['--no-enu', '--recolor'],
    sceneMode: false, archType: 'crystalline-crown',
  },
  {
    key: 'tribune-tower', name: 'Tribune Tower', city: 'Chicago, IL',
    coords: '41.8903,-87.6233', extentM: 40,
    glb: `${DIR}/tribune-tower.glb`,
    // --force-recolor --building-colour tan: Tribune Tower is Indiana limestone (warm tan/cream)
    resolution: 1, maskDilate: 2, extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'tan'],
    sceneMode: false, archType: 'neo-gothic',
  },
  {
    key: 'vessel-nyc', name: 'The Vessel', city: 'New York, NY',
    coords: '40.7536,-74.0022', extentM: 20,
    glb: `${DIR}/vessel-nyc.glb`,
    // r=2: needed for honeycomb stair detail; 'copper' now in named map → warm brown-orange
    resolution: 2, maskDilate: 1, extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'copper'],
    sceneMode: false, archType: 'honeycomb',
  },
  {
    key: 'disney-hall', name: 'Walt Disney Concert Hall', city: 'Los Angeles, CA',
    coords: '34.0553,-118.2498', extentM: 60,
    glb: `${DIR}/disney-hall.glb`,
    // r=2: stainless steel curved panels; --force-recolor --building-colour chrome: brushed steel
    // NOTE: 'silver' maps to light_gray_concrete (in GRAY_FAMILY) → guard blocks it; 'chrome' maps to smooth_quartz
    resolution: 2, maskDilate: 0, osmId: 'relation/6333150',
    extraFlags: ['--no-enu', '--force-recolor', '--building-colour', 'chrome'], sceneMode: false, archType: 'deconstructivist',
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
