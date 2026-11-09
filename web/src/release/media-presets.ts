/**
 * Image and video presets for store, gallery and site media (BIZ-62 / X-14, plan D section 6).
 *
 * Every preset is under 2000 px on each side and under 4 MB: the limits are constants here, the offline
 * renderer (`scripts/media-turntable.ts`) encodes to the preset's byte budget, and the tests walk the table.
 * Platform limits marked `verify` in `note` are the plan's best knowledge, not read from the platform: the
 * channel bundle (D-09) lists them as unverified.
 */

/** A rendered image side must be strictly below this many pixels (the project's screenshot rule). */
export const MAX_SIDE_EXCLUSIVE = 2000;
/** An encoded image or clip must be strictly below this many bytes: 4,000,000 satisfies both a 4 MB and a 4 MiB reading. */
export const MAX_BYTES_EXCLUSIVE = 4_000_000;

export type StillFormat = 'png' | 'jpg' | 'webp';

/** The camera and composition a preset asks of the framing module. */
export interface PresetFraming {
  /** Fraction of the frame WIDTH the model's widest extent may fill (the acceptance window is 0.55 to 0.75). */
  fillWidth: number;
  /** Fraction of the frame HEIGHT the model may fill: a wide banner is limited by this, not by its width. */
  fillHeight: number;
  /** Camera look direction (x, y, z) used by stills; y negative looks down. */
  dir: readonly [number, number, number];
  /** Vertical field of view, degrees. */
  fovDeg: number;
}

interface PresetBase {
  /** Stable id, used as the CLI value and the output folder name. */
  id: string;
  width: number;
  height: number;
  /** What the image is used for; carries any "size to verify" caveat. */
  note: string;
  framing: PresetFraming;
}

export interface StillPreset extends PresetBase {
  kind: 'still';
  format: StillFormat;
  /** The byte budget this preset's file must stay under (never above `MAX_BYTES_EXCLUSIVE`). */
  maxBytes: number;
}

export interface TurntablePreset extends PresetBase {
  kind: 'turntable';
  /** Frames per revolution (the CLI may override). */
  frames: number;
  fps: number;
  /** The animated GIF is rendered at this width so it can stay under the byte budget. */
  gifWidth: number;
}

export type MediaPreset = StillPreset | TurntablePreset;

const HERO: PresetFraming = { fillWidth: 0.68, fillHeight: 0.8, dir: [1, -0.6, 1.4], fovDeg: 40 };
const WIDE: PresetFraming = { ...HERO, fillWidth: 0.6, fillHeight: 0.8 };
const BANNER: PresetFraming = { ...HERO, fillWidth: 0.5, fillHeight: 0.8 };
const SQUARE: PresetFraming = { ...HERO, fillWidth: 0.72, fillHeight: 0.78 };

const still = (id: string, width: number, height: number, format: StillFormat, note: string, framing: PresetFraming, maxBytes = MAX_BYTES_EXCLUSIVE - 1): StillPreset =>
  ({ kind: 'still', id, width, height, format, note, framing, maxBytes });

/** Every preset, in the order the plan lists them. */
export const MEDIA_PRESETS: readonly MediaPreset[] = [
  still('cf-logo', 800, 800, 'png', 'CurseForge logo (at least 400x400, 1:1)', SQUARE),
  still('screenshot', 1600, 900, 'png', 'CurseForge and itch screenshots, site carousel', WIDE),
  still('itch-cover', 630, 500, 'png', 'itch.io cover', HERO),
  still('itch-cover-2x', 1260, 1000, 'png', 'itch.io cover at 2x', HERO),
  still('mcpedl-thumb', 1280, 720, 'png', 'MCPEDL thumbnail (size to verify)', WIDE),
  still('og', 1200, 630, 'jpg', 'link previews on the site', WIDE),
  still('yt-thumb', 1280, 720, 'jpg', 'video thumbnail, under 2 MB', WIDE, 2_000_000 - 1),
  still('banner', 1600, 400, 'jpg', 'Patreon and Ko-fi cover (size to verify)', BANNER),
  still('avatar', 512, 512, 'png', 'profile picture', SQUARE),
  { kind: 'turntable', id: 'turntable', width: 1080, height: 1080, note: 'site hero loop', framing: SQUARE, frames: 72, fps: 24, gifWidth: 540 },
  { kind: 'turntable', id: 'turntable-vertical', width: 1080, height: 1920, note: 'shorts and reels (9:16)', framing: { ...SQUARE, fillWidth: 0.74 }, frames: 72, fps: 24, gifWidth: 360 },
];

/** Look a preset up by id; throws with the valid ids when it is unknown. */
export function presetById(id: string): MediaPreset {
  const hit = MEDIA_PRESETS.find(p => p.id === id);
  if (!hit) throw new Error(`unknown preset "${id}"; valid: ${MEDIA_PRESETS.map(p => p.id).join(', ')}`);
  return hit;
}

/** The presets a `--preset=` value names: `all`, or a comma list of ids. */
export function selectPresets(value: string): MediaPreset[] {
  return value === 'all' ? [...MEDIA_PRESETS] : value.split(',').map(s => presetById(s.trim()));
}

/** The pixel size a frame is rendered at before it is downscaled to the preset: `supersample` times the preset. */
export function renderSize(p: MediaPreset, supersample: number): { width: number; height: number } {
  return { width: Math.round(p.width * supersample), height: Math.round(p.height * supersample) };
}
