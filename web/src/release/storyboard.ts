/**
 * Trailer storyboard schema and validator (D-16, BIZ-62; plan D section D-16).
 *
 * `release/media/<product>.storyboard.json` is a 30-45 s shot list cut twice
 * (16:9 and 9:16 from the SAME shots; each shot says how it is framed in both).
 * Every shot names the pack it is played from (sha256), the wand size and the
 * position in the world, so the shot section of a device-round brief can be
 * generated from it. This module touches no phone and renders nothing: the
 * offline animatic belongs to X-14 (`media-turntable.ts`) and `_cockpit_view.ts`.
 */
import { SIZE_STEPS } from '../engine/bedrock-placement-pack.js';

/** The two cuts every storyboard carries. */
export const STORYBOARD_ASPECTS = ['16:9', '9:16'] as const;
export type StoryboardAspect = typeof STORYBOARD_ASPECTS[number];
/** Trailer length limits in seconds (plan D section 6). */
export const STORYBOARD_MIN_SEC = 30;
export const STORYBOARD_MAX_SEC = 45;
/** `screenrecord` on the device stops a clip at 180 s; a device shot is far shorter, but the brief says so. */
export const SCREENRECORD_LIMIT_SEC = 180;
/** Camera modes a shot may use: the in-game ones are device captures, `offline-turntable` is rendered here. */
export const STORYBOARD_CAMERAS = [
  'first-person', 'third-person-back', 'third-person-front', 'third-person-chase', 'cockpit-hotbar9', 'offline-turntable',
] as const;
export type StoryboardCamera = typeof STORYBOARD_CAMERAS[number];
/** `device` shots are captured through the device-round process; `offline` shots are rendered on this PC. */
export type ShotSource = 'device' | 'offline';

/** Where the shot stands, in blocks from the placement pin, and which way the camera subject faces. */
export interface ShotPosition { x: number; y: number; z: number; yawDeg: number }

export interface StoryboardShot {
  id: string;
  title: string;
  source: ShotSource;
  durationSec: number;
  camera: StoryboardCamera;
  /** sha256 (lowercase hex) of the `.mcaddon` the shot is played from. */
  packSha256: string;
  /** Wand size step in percent; one of the pack's shipped `SIZE_STEPS`. */
  wandSizePct: number;
  position: ShotPosition;
  /** What happens, one sentence, for the capture brief. */
  action: string;
  /** How the shot is framed in each cut. */
  framing: Record<StoryboardAspect, string>;
}

export interface Storyboard {
  product: string;
  /** `draft`: the pack is not built yet, so an all-zero sha256 stands for "the pack to be built". `locked`: real hashes only. */
  status: 'draft' | 'locked';
  aspects: StoryboardAspect[];
  shots: StoryboardShot[];
}

/** The draft marker: legal only while `status` is `draft` (the plan's pack does not exist yet). */
export const DRAFT_SHA256 = '0'.repeat(64);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHOT_ID = /^[a-z][a-z0-9-]*$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Total running time of a shot list in seconds. */
export function storyboardDuration(shots: ReadonlyArray<{ durationSec: number }>): number {
  return shots.reduce((sum, s) => sum + (isNum(s.durationSec) ? s.durationSec : 0), 0);
}

/** Problems of one shot, each prefixed with `shot <id>:`. */
function shotProblems(s: unknown, index: number, status: unknown): string[] {
  if (!isObj(s)) return [`shot #${index + 1} is not an object`];
  const label = typeof s.id === 'string' && s.id !== '' ? s.id : `#${index + 1}`;
  const out: string[] = [];
  const bad = (msg: string): void => { out.push(`shot ${label}: ${msg}`); };
  if (typeof s.id !== 'string' || !SHOT_ID.test(s.id)) bad(`id must match ${SHOT_ID}`);
  if (typeof s.title !== 'string' || s.title.trim() === '') bad('title is empty');
  if (s.source !== 'device' && s.source !== 'offline') bad('source must be "device" or "offline"');
  if (!isNum(s.durationSec) || s.durationSec <= 0) bad('durationSec must be a positive number');
  if (!STORYBOARD_CAMERAS.includes(s.camera as StoryboardCamera)) bad(`camera must be one of ${STORYBOARD_CAMERAS.join(', ')}`);
  if (typeof s.packSha256 !== 'string' || !SHA256_HEX.test(s.packSha256)) {
    bad('packSha256 must name the pack by 64 lowercase hex characters');
  } else if (s.packSha256 === DRAFT_SHA256 && status !== 'draft') {
    bad('the all-zero packSha256 is legal only while the storyboard status is draft');
  }
  if (!isNum(s.wandSizePct) || !SIZE_STEPS.includes(s.wandSizePct)) bad(`wandSizePct must be one of ${SIZE_STEPS.join(', ')}`);
  const p = s.position;
  if (!isObj(p) || !isNum(p.x) || !isNum(p.y) || !isNum(p.z) || !isNum(p.yawDeg)) bad('position needs numeric x, y, z and yawDeg');
  if (typeof s.action !== 'string' || s.action.trim() === '') bad('action is empty');
  const framing = s.framing;
  for (const aspect of STORYBOARD_ASPECTS) {
    if (!isObj(framing) || typeof framing[aspect] !== 'string' || (framing[aspect] as string).trim() === '') {
      bad(`framing is missing the ${aspect} cut`);
    }
  }
  return out;
}

/**
 * Every problem with a parsed storyboard; an empty list means it is valid.
 * Takes `unknown` because it validates JSON read from disk.
 */
export function validateStoryboard(board: unknown): string[] {
  if (!isObj(board)) return ['storyboard is not an object'];
  const out: string[] = [];
  if (typeof board.product !== 'string' || board.product === '') out.push('product is empty');
  if (board.status !== 'draft' && board.status !== 'locked') out.push('status must be "draft" or "locked"');
  const aspects = Array.isArray(board.aspects) ? board.aspects : [];
  for (const a of STORYBOARD_ASPECTS) {
    if (!aspects.includes(a)) out.push(`aspects must list the ${a} cut`);
  }
  if (!Array.isArray(board.shots) || board.shots.length === 0) return [...out, 'shots is empty'];
  const ids = new Set<string>();
  board.shots.forEach((s: unknown, i: number) => {
    out.push(...shotProblems(s, i, board.status));
    const id = isObj(s) ? s.id : undefined;
    if (typeof id === 'string') {
      if (ids.has(id)) out.push(`duplicate shot id ${id}`);
      ids.add(id);
    }
  });
  const total = storyboardDuration(board.shots as StoryboardShot[]);
  if (total > STORYBOARD_MAX_SEC) out.push(`total duration ${total} s is over the ${STORYBOARD_MAX_SEC} s limit`);
  if (total < STORYBOARD_MIN_SEC) out.push(`total duration ${total} s is under the ${STORYBOARD_MIN_SEC} s minimum`);
  return out;
}

/**
 * The shot section of a device-round brief: one entry per DEVICE shot (offline
 * shots are rendered on this PC and never reach a phone), in storyboard order.
 * Hand this text to `.claude/skills/bedrock-device-round.md`; nothing here runs a device.
 */
export function renderShotBrief(board: Storyboard): string {
  const device = board.shots.filter(s => s.source === 'device');
  const lines = [
    `## Trailer shots: ${board.product} (${board.status})`,
    '',
    `${device.length} device capture(s). Clips are recorded with screenrecord, which stops at ${SCREENRECORD_LIMIT_SEC} s per clip.`,
    `Record both cuts from one take: frame for 9:16 inside the 16:9 view.`,
    '',
  ];
  for (const s of device) {
    const p = s.position;
    lines.push(
      `### ${s.id}: ${s.title} (${s.durationSec} s)`,
      `- pack sha256: ${s.packSha256}`,
      `- wand size: ${s.wandSizePct} %`,
      `- position: x ${p.x}, y ${p.y}, z ${p.z}, facing ${p.yawDeg} degrees (blocks from the placement pin)`,
      `- camera: ${s.camera}`,
      `- action: ${s.action}`,
      `- framing 16:9: ${s.framing['16:9']}; 9:16: ${s.framing['9:16']}`,
      '',
    );
  }
  return lines.join('\n');
}
