/**
 * The brick core's shared data types (business plan A section 2.3, README 1.1).
 *
 * `brickgen` turns intent (a lattice of labelled cells, from a grammar or from a
 * mesh) into a legal arrangement of OFFICIAL LDraw parts and writes it as an
 * `.ldr`/MPD. Every stage of the pipeline speaks these types, so this file is
 * the contract: change a field here and every stage must follow.
 *
 * Coordinate conventions (one place, so no stage invents its own):
 *  - The stud lattice is x east, z south (the same x/z as LDraw), `plate` up.
 *    One cell is 1 stud x 1 plate x 1 stud = 20 x 8 x 20 LDU.
 *  - LDraw's y axis points DOWN, so plate layer `p` spans LDraw y in
 *    `[-(p + 1) * 8, -p * 8]`.
 *  - Site-level types (`Vec2m`, `Vec3m`, `SiteEvidence`, ...) are metres in a
 *    local east-north-up frame centred on the site, y up.
 */

/** Metres in a local east-north-up frame centred on the site; y up. */
export type Vec2m = readonly [x: number, z: number];
/** Metres in a local east-north-up frame centred on the site; y up. */
export type Vec3m = readonly [x: number, y: number, z: number];

/** Every input carries its licence; the gate refuses a commercial run on a forbidden one. */
export type InputLicence =
  | 'own-work' | 'public-domain' | 'cc0' | 'cc-by' | 'cc-by-sa' | 'odbl' | 'ogl-uk' | 'licence-ouverte'
  | 'us-gov' | 'dl-de-zero' | 'google-maps-content' | 'unknown';

/** One recorded input of a design (a map, a photo, a measurement) with its licence. */
export interface SourceRef {
  /** Stable within a design, e.g. `"osm-way-<id>"`. */
  id: string;
  kind: 'osm' | 'lidar' | 'mesh' | 'photo' | 'drawing' | 'measurement' | 'text';
  url?: string;
  /** ISO date the input was retrieved. */
  retrieved: string;
  sha256?: string;
  licence: InputLicence;
  attribution?: string;
  /** What the design took from it: "footprint", "tower height", "rose window diameter". */
  usedFor: string[];
}

/** Everything known about a real site before any massing is chosen. */
export interface SiteEvidence {
  /** Working title, never a LEGO set name. */
  name: string;
  sources: SourceRef[];
  footprint: Array<{ outer: Vec2m[]; holes: Vec2m[][]; partId?: string }>;
  parts: Array<{ partId: string; baseM: number; heightM: number; roof?: RoofSpec; colourHint?: string }>;
  /** Documented dimensions. */
  measurements: Array<{ what: string; valueM: number; source: string }>;
  /** Human/agent marks on licensed photos or drawings. */
  annotations: FacadeAnnotation[];
  /** Licence-clean 3D input only. */
  mesh?: { positions: Float32Array; indices: Uint32Array; source: string };
}

/** Marks on one rectified facade photo or drawing. */
export interface FacadeAnnotation {
  /** `SourceRef` id of the photo or drawing. */
  source: string;
  /** Footprint edge index. */
  edge: number;
  /** Metres per pixel after rectification. */
  rectifiedScale: number;
  marks: Array<{ kind: FeatureKind; boxPx: [number, number, number, number]; note?: string }>;
}

export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'dome' | 'onion' | 'conical' | 'mansard' | 'shed' | 'spire';

export interface RoofSpec {
  shape: RoofShape;
  pitchDeg?: number;
  ridgeAxis?: 'long' | 'short';
  colour?: number;
  overhangM?: number;
}

/** One extruded building volume. */
export interface MassVolume {
  id: string;
  outer: Vec2m[];
  holes: Vec2m[][];
  baseM: number;
  topM: number;
  roof: RoofSpec;
  role: 'body' | 'tower' | 'nave' | 'aisle' | 'transept' | 'apse' | 'podium' | 'deck' | 'pier' | 'terrain';
}

/** How metres become studs. 1 stud = 20 LDU; 1 plate = 8 LDU; a brick = 3 plates. */
export interface ModelScale {
  studsPerMetre: number;
  platesPerMetre: number;
  reason: string;
}

export interface Massing {
  volumes: MassVolume[];
  scale: ModelScale;
  boundsM: [Vec3m, Vec3m];
}

export type FeatureKind =
  | 'window' | 'lancet' | 'rose' | 'door' | 'portal' | 'arcade' | 'column' | 'pilaster' | 'buttress'
  | 'flying-buttress' | 'cornice' | 'balustrade' | 'pinnacle' | 'gargoyle' | 'clock' | 'spire' | 'dome'
  | 'lantern' | 'battlement' | 'chimney' | 'balcony' | 'stair' | 'lattice' | 'cable' | 'statue';

export interface FeatureSpec {
  kind: FeatureKind;
  /** Id of the `MassVolume` it belongs to. */
  volume: string;
  edge?: number;
  /** Position along the edge and height, metres. */
  atM: Vec3m;
  /** Size, metres. */
  sizeM: Vec3m;
  count?: number;
  spacingM?: number;
  confidence: number;
  sources: string[];
}

export interface StyleProfile {
  wallColour: number;
  trimColour: number;
  roofColour: number;
  accentColours: number[];
  era?: string;
}

export interface FeatureSet {
  features: FeatureSpec[];
  style: StyleProfile;
}

/** What a lattice cell is FOR, before any part is chosen. `solid` is the mesh front-end's label (no architectural intent). */
export type IntentRole =
  | 'wall' | 'floor' | 'roof-slope' | 'roof-flat' | 'window' | 'arch' | 'column' | 'trim' | 'detail'
  | 'terrain' | 'support' | 'solid';

/** One cell per stud column x plate layer; 0 = empty, otherwise 1 + index into `labels`. */
export interface IntentLattice {
  dims: [studsX: number, plates: number, studsZ: number];
  /** 0 empty; otherwise 1 + an index into `labels`. */
  cells: Uint16Array;
  labels: IntentLabel[];
}

export interface IntentLabel {
  role: IntentRole;
  /** LDraw colour code. */
  colour: number;
  feature?: string;
  /** Roof slope direction (+x, -x, +z, -z) and steepness class, for the slope picker. */
  slope?: { dir: 0 | 1 | 2 | 3; rise: 1 | 2 | 3 };
  /** May be built hollow (no interior studs needed). */
  hollowOk?: boolean;
}

/** One vocabulary element: an OFFICIAL LDraw part with what the bricker needs to know. */
export interface BrickElement {
  /** `"3001.dat"`. */
  part: string;
  /** Studs along x and z, in the part's own (turn 0) orientation. */
  footprint: [studsX: number, studsZ: number];
  /** Body height in plates (studs excluded). */
  heightPlates: number;
  /**
   * Occupancy of the part's envelope, one byte per cell (1 = occupied), for
   * non-cuboid parts (slopes, arches, rounds). Index `x + fx * (z + fz * layer)`
   * with layer 0 the lowest plate; see `occupancyIndex` in `vocab/occupancy.ts`.
   * Absent for a full cuboid.
   */
  occupancy?: Uint8Array;
  /** Stud/anti-stud cells `[x, z]` read from the part's geometry, and any side connection. */
  connections: { studsTop: Array<[number, number]>; antiStudsBottom: Array<[number, number]>; side?: 'clip' | 'bar' | 'pin' };
  roles: IntentLabel['role'][];
  /** The part's `0 !LICENSE` line. */
  licence: string;
  /** The part's `0 Author:` line. */
  author: string;
}

export interface BrickVocabulary {
  elements: BrickElement[];
  palette: number[];
  version: string;
}

/**
 * The bricker's output: parts on the stud lattice.
 *
 * `at` is the lattice cell of the element's lowest, minimum-x/z corner AFTER the
 * turn is applied (so a 2x4 brick turned once covers 2 studs in x and 4 in z
 * starting at `at`). `turn` is a quarter turn about the vertical axis; the exact
 * matrix is written by `emit/ldraw-writer.ts` (`turnMatrix`).
 */
export interface PlacedElement {
  part: string;
  colour: number;
  at: [sx: number, plate: number, sz: number];
  turn: 0 | 1 | 2 | 3;
  group: string;
}

export interface BrickPlan {
  elements: PlacedElement[];
  groups: Array<{ id: string; label: string }>;
  scale: ModelScale;
  metas: AuthoringMeta[];
}

/**
 * Explicit intent written into the `.ldr` so the add-on pipeline need not guess
 * (registered in `engine/ldraw-directives.ts`, read by `engine/ldraw-parser.ts`).
 * Positions are LDU in the written model's LDraw frame (y down).
 */
export type AuthoringMeta =
  | { kind: 'FIGURE'; system: 'brickling'; at: [number, number, number]; facingDeg: number; seat?: string }
  | { kind: 'SEAT'; id: string; at: [number, number, number]; facingDeg: number }
  | { kind: 'DOOR'; group: string; hinge: [number, number, number]; axis: 'y'; openDeg: number }
  | { kind: 'SPAWN'; at: [number, number, number] }
  | { kind: 'DESIGN'; slug: string; version: string; provenance: string };

export interface VerifyReport {
  parts: number;
  components: number;
  largestPct: number;
  /** Elements with no load path to the ground through stud connections. */
  unsupported: number;
  /** Worst cantilever, in studs, beyond the allowed limit. */
  cantileverViolations: Array<{ group: string; studs: number }>;
  overlaps: number;
  illegalParts: string[];
  budget: { cuboidsEstimate: number; parts: number };
}

export interface PolishOp {
  op: 'remove' | 'add' | 'replace' | 'recolour' | 'regrammar';
  /** A box in lattice coordinates, or a group id. */
  where: { box?: [[number, number, number], [number, number, number]]; group?: string };
  with?: PlacedElement[] | { part?: string; colour?: number } | { grammar: string; params: Record<string, unknown> };
  /** Reviewer's reason, kept for the provenance log. */
  why: string;
}

export interface CleanroomResult {
  /** A corpus path, hashed. */
  checkedAgainst: string;
  partHistogramCosine: number;
  alignedVoxelIoU: number;
  verdict: 'independent' | 'review';
  /** A DIFFERENT agent than the designer. */
  by: string;
  at: string;
}

export interface ProvenanceLog {
  slug: string;
  title: string;
  created: string;
  designers: string[];
  /** The independent-creation statement. */
  statement: string;
  sources: SourceRef[];
  pipeline: { commit: string; brickgenVersion: string; command: string };
  polish: Array<{ op: PolishOp; by: string; at: string }>;
  clearance: CleanroomResult[];
}
