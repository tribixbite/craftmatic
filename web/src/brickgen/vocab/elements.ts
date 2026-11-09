/**
 * The curated list of vocabulary parts and how each is read.
 *
 * Only the CHOICE lives here (which official part, what it is for, how its
 * envelope is read). Footprint, height, occupancy, studs, anti-studs, licence
 * and author are derived from the part's geometry and header by
 * `scripts/_vendor_ldraw_vocab.ts` into `vocabulary.generated.ts`.
 *
 * Every part is an OFFICIAL LDraw library part (`ldraw_ref/official`), never a
 * Studio-only mesh and never a `bl_` copy: the part-source ledger (BIZ-07)
 * depends on that. Obsolete aliases ("~Moved to ...", "(Obsolete)") are
 * listed under their real part id (3023b, 3040b, 3665a, 4287a).
 */
import type { IntentRole } from '../types.js';
import type { OccupancyMode } from './occupancy.js';

export interface ElementSpec {
  /** Official part file, e.g. `3001.dat`. */
  part: string;
  /** Family, for diagnostics and the bricker's picks. */
  kind: 'brick' | 'plate' | 'tile' | 'slope' | 'slope-inverted' | 'slope-curved' | 'arch' | 'round' | 'cone' | 'dome'
    | 'window' | 'door-frame' | 'bracket' | 'fence';
  /** How the envelope is read: solid between top and bottom, or even-odd for parts with voids. */
  mode: OccupancyMode;
  roles: IntentRole[];
  /** Side connection, where the part has one the verifier should know about. */
  side?: 'clip' | 'bar' | 'pin';
}

const S = (part: string, kind: ElementSpec['kind'], roles: IntentRole[], mode: OccupancyMode = 'envelope'): ElementSpec =>
  ({ part: `${part}.dat`, kind, mode, roles });

const BRICK: IntentRole[] = ['wall', 'column', 'support', 'solid', 'terrain'];
const PLATE: IntentRole[] = ['floor', 'roof-flat', 'terrain', 'support', 'solid'];
const TILE: IntentRole[] = ['roof-flat', 'trim', 'floor', 'detail'];
const SLOPE: IntentRole[] = ['roof-slope'];
const SLOPE_INV: IntentRole[] = ['roof-slope', 'trim'];
const ARCH: IntentRole[] = ['arch'];

export const ELEMENT_SPECS: readonly ElementSpec[] = [
  // Bricks 1xN and 2xN
  ...['3005', '3004', '3622', '3010', '3009', '3008', '6111', '6112', '3003', '3002', '3001', '2456', '3007', '3006']
    .map(p => S(p, 'brick', BRICK)),
  // Plates 1xN, 2xN, 4x4
  ...['3024', '3023b', '3623', '3710', '3666', '3460', '4477', '3022', '3021', '3020', '3795', '3034', '3832', '3031']
    .map(p => S(p, 'plate', PLATE)),
  // Tiles
  ...['3070b', '3069b', '63864', '2431', '6636', '3068b'].map(p => S(p, 'tile', TILE)),
  // Slopes: 45 degree, 33 degree
  ...['3040b', '3039', '3038', '3037', '3045', '3046', '3298', '3297', '4286'].map(p => S(p, 'slope', SLOPE)),
  // Inverted slopes
  ...['3665a', '3676', '3747b', '4287a'].map(p => S(p, 'slope-inverted', SLOPE_INV)),
  // Curved slopes (the Inverted ones read as inverted)
  S('11477', 'slope-curved', SLOPE), S('85984', 'slope', SLOPE), S('15068', 'slope-curved', SLOPE),
  S('24201', 'slope-inverted', SLOPE_INV), S('13547', 'slope-inverted', SLOPE_INV),
  // Arches 1x3 .. 1x12 (and 2x8)
  ...['3659', '6182', '4490', '6005', '2339', '30099', '12939', '14707', '13965', '4743'].map(p => S(p, 'arch', ARCH, 'parity')),
  // Round bricks, plates and tiles
  S('3062b', 'round', ['column', 'detail']), S('6141', 'round', ['detail', 'column']),
  S('4150', 'round', ['roof-flat', 'detail']), S('14769', 'round', ['roof-flat', 'detail']), S('98138', 'round', ['roof-flat', 'detail']),
  // Cones and a dome
  S('4589', 'cone', ['roof-slope', 'detail']), S('3942c', 'cone', ['roof-slope', 'detail']), S('272', 'cone', ['roof-slope', 'detail']),
  S('15395', 'dome', ['roof-slope', 'detail']),
  // Windows and door frames
  ...['60592', '60593', '60594', '60598', '30044'].map(p => S(p, 'window', ['window'], 'parity')),
  ...['60596', '60599'].map(p => S(p, 'door-frame', ['window'], 'parity')),
  // Brackets (side studs: TODO(X-09) model SNOT connections once the verifier reads them)
  S('99781', 'bracket', ['detail', 'support']), S('44728', 'bracket', ['detail', 'support']),
  // Lattice and spindled fences
  ...['3633', '3185', '30055', '30077'].map(p => S(p, 'fence', ['detail', 'trim'], 'parity')),
];
