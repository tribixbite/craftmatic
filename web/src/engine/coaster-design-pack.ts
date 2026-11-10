/**
 * A `CoasterDesign` as a whole add-on (WP-C02, BIZ-13): `generateCoaster`, then the runtime route
 * (`coasterRouteFromGenerated`), the rail chunks (`coasterTrack`) and our own car, through
 * `buildPlayableAddon`. There is no source model: the pack's blocks are only the station platform, and
 * everything that moves or is drawn is an entity.
 */
import { BlockGrid } from '@craft/schem/types.js';
import { generateCoaster, type CoasterDesign, type GeneratedCoaster } from './coaster-design.js';
import { coasterRouteFromGenerated, parseCoasterCar, placeGenerated, PLACE_DEFAULTS, type OwnCoasterCar, type RouteOptions } from './coaster-pack.js';
import type { CoasterRoute } from './bedrock-coaster.js';
import { buildPlayableAddon, type PlayableAddonOptions, type PlayableAddonResult } from './playable-addon.js';

export interface GeneratedCoasterPackOptions extends RouteOptions {
  /** File stem of the pack (default the design's name reduced to words). */
  stem?: string;
  /** Extra `buildPlayableAddon` options (profile, clock, partGeometry, pipelineStamp...). */
  addon?: Partial<PlayableAddonOptions>;
}

export interface GeneratedCoasterPack {
  stem: string;
  result: PlayableAddonResult;
  gen: GeneratedCoaster;
  route: CoasterRoute;
  car: OwnCoasterCar;
}

/** The station platform: one block of stone brick under the station zone's span and a block either side of it. */
function platformGrid(gen: GeneratedCoaster, margin: number, ground: number): BlockGrid {
  const placed = placeGenerated(gen, { marginB: margin, groundB: ground });
  const station = gen.zones.find(z => z.kind === 'station');
  if (!station) throw new Error('coaster design: no station zone.');
  // The station runs along +x from the design's origin.
  const x0 = Math.floor(placed.offset[0]) - 1, z0 = Math.floor(placed.offset[2]) - 3;
  const x1 = Math.ceil(placed.offset[0] + station.to - station.from) + 1, z1 = Math.floor(placed.offset[2]) + 3;
  const grid = new BlockGrid(x1 + 2, Math.max(1, Math.ceil(ground)), z1 + 2);
  for (let x = Math.max(0, x0); x <= x1; x++) for (let z = Math.max(0, z0); z <= z1; z++) for (let y = 0; y < Math.ceil(ground); y++) grid.set(x, y, z, 'minecraft:stone_bricks');
  return grid;
}

/**
 * Generate the design and build its add-on.
 *
 * @param carText the car fixture's text (`test/fixtures/coaster/own-car.ldr`)
 * @throws when the design fails its own validator (`generateCoaster`), has no station, or the car is not a car
 */
export async function buildGeneratedCoasterPack(design: CoasterDesign, carText: string, options: GeneratedCoasterPackOptions = {}): Promise<GeneratedCoasterPack> {
  const gen = generateCoaster(design);
  const car = parseCoasterCar(carText);
  const label = options.label ?? design.name.replace(/\s*\(.*$/, '');
  const route = coasterRouteFromGenerated(gen, design, car, { ...options, label });
  const margin = options.marginB ?? PLACE_DEFAULTS.marginB, ground = options.groundB ?? PLACE_DEFAULTS.groundB;
  const stem = options.stem ?? (design.name.replace(/\(.*$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'coaster');
  const result = await buildPlayableAddon(platformGrid(gen, margin, ground), {
    stem, label, coasterRoutes: [route],
    coasterTrack: { gen, car, marginB: margin, groundB: ground }, ...options.addon,
  });
  return { stem, result, gen, route, car };
}
