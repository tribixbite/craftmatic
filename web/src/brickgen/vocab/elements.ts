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
  // L-01 (BIZ-33): the most frequent official parts the batcave car and the nimbus fixture place that the list
  // above lacked (counted by scripts/_vendor_ldraw_vocab.ts's parent task, 2026-11-09), so the V-02 truth reads
  // their footprint instead of their mesh. Obsolete ("~") and alias ("=") library entries are left out.
  // Plates: 2x2 corner, 2x2 without / with round corner, 3x3 without corner, 3x3 cross, 4x6, 6x6, 1x2 with clip, 1x1 x 2/3
  // (1x2 with handle 60478, with door rail 32028 and curved 1x8 85970 were tried: their sideways parts made the footprint read one stud too wide)
  ...['2420', '26601', '79491', '2450', '15397', '3032', '3958', '92280', '86996'].map(p => S(p, 'plate', PLATE)),
  S('18674', 'round', ['roof-flat', 'detail']),
  // Bricks: 2x2 corner, 1x1 with headlight, 1x1x1 2/3 with side studs, Technic bricks with holes
  ...['2357', '4070', '32952', '3700', '3701', '2730', '32000', '73230', '6541'].map(p => S(p, 'brick', BRICK)),
  // Slopes: 31 degree 1x1x2/3 (origin at its bottom), 45 degree 2x1 plate, 18 degree 4x1, curved 4x1 / 2x1 cutouts / 8x1 arch
  ...['54200', '15672', '60477'].map(p => S(p, 'slope', SLOPE)),
  ...['61678', '29119', '29120'].map(p => S(p, 'slope-curved', SLOPE)),
  S('50967', 'slope-curved', SLOPE, 'parity'), S('78666', 'arch', ARCH, 'parity'),
  // Brackets
  ...['36841', '36840', '99780', '99207', '11215'].map(p => S(p, 'bracket', ['detail', 'support'])),
  // The real parts behind more "~Moved to" names (see MOVED_PARTS)
  S('2362b', 'brick', BRICK), S('3048b', 'slope', SLOPE), S('3747a', 'slope-inverted', SLOPE_INV),
  S('3070a', 'tile', TILE),
  // Lattice and spindled fences
  ...['3633', '3185', '30055', '30077'].map(p => S(p, 'fence', ['detail', 'trim'], 'parity')),
];

/**
 * Official "~Moved to" library entries: a model (an LDraw file, an OMR set) may place the OLD name of a part
 * (`3023.dat`, 23 times in the batcave car) whose library file is one line, an identity reference to the real
 * part (`3023b.dat`). The vocabulary reads such a name as the part it points at, with the same frame (the
 * reference is the identity). `scripts/_vendor_ldraw_vocab.ts` vendors each alias file, fails when one is not a
 * single identity reference to the target below, or when the target is not an element, and credits its author
 * in LICENSE.md. Derived 2026-11-09 by scanning the official library for `0 ~Moved to` files whose single
 * reference is a vocabulary part.
 */
export const MOVED_PARTS: Readonly<Record<string, string>> = {
  '101.dat': '3623.dat', '157.dat': '4070.dat', '234.dat': '4286.dat', '2362.dat': '2362b.dat', '238.dat': '3048b.dat',
  '2431b.dat': '2431.dat', '248.dat': '3676.dat', '278.dat': '4490.dat', '28.dat': '3062b.dat', '299.dat': '4589.dat',
  '3023.dat': '3023b.dat', '3040.dat': '3040b.dat', '3048.dat': '3048b.dat', '3062.dat': '3062b.dat', '3068.dat': '3068b.dat',
  '3069.dat': '3069b.dat', '3070.dat': '3070a.dat', '3665.dat': '3665a.dat', '3747.dat': '3747a.dat', '40.dat': '3046.dat',
  '404.dat': '6541.dat', '4073.dat': '6141.dat', '4287.dat': '4287a.dat', '47.dat': '3659.dat', '57.dat': '3045.dat',
  '602.dat': '32000.dat', '9.dat': '3460.dat',
};
