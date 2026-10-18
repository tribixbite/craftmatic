/**
 * Where a touch DRAG goes, by the player's control scheme and seat (quirks
 * `control-scheme-drag-to-camera`, `rider-free-look`, `native-mount-locked-look`):
 *
 *   default scheme (none set, `/controlscheme @s clear`, or
 *   `locked_player_relative_strafe`)  a drag turns the player's yaw and pitch;
 *     on a seat whose `lock_rider_rotation` is 0 the yaw is held to the seat
 *     and only the pitch moves (pinball, Pixel 2026-09-25);
 *   `player_relative`, `camera_relative`  a drag turns the client's camera
 *     ORBIT (the Follow Orbit camera), never the player; with a script
 *     `minecraft:free` camera active it turns nothing at all.
 *
 * Pure: the players system asks `dragRoute` and applies the answer.
 */

/**
 * Control schemes under which a touch drag turns only the CAMERA, never the player (Microsoft Learn, "Control
 * Schemes": player relative and camera relative "Drag on the screen to rotate the camera"; quirk
 * `control-scheme-drag-to-camera`). Every pack's ride is watched from a script camera, which no drag moves.
 */
export const DRAG_TO_CAMERA_SCHEMES: ReadonlySet<string> = new Set(['player_relative', 'camera_relative']);

/** What a drag moves. */
export type DragRoute =
  /** The player's yaw and pitch (the default scheme, free seats, walking). */
  | 'look'
  /** The pitch only: the yaw is held to a lock-0 seat. */
  | 'pitch-only'
  /** The client's camera orbit only (a drag-to-camera scheme, no script camera): the player does not turn. */
  | 'orbit'
  /** Nothing (a drag-to-camera scheme under a script camera). */
  | 'none';

/** What decides a drag's route. */
export interface DragContext {
  /** The scheme a script set (`/controlscheme`, `Player.setControlScheme`); undefined = the default. */
  scheme: string | undefined;
  /** The `lock_rider_rotation` of the seat the player rides, when riding (undefined = not riding, or not declared). */
  seatLock: number | undefined;
  /** Whether the player is riding at all. */
  riding: boolean;
  /** Whether a script camera (`setCamera`) is active for the player. */
  scriptCamera: boolean;
}

/** Where a drag goes (see the module header). */
export function dragRoute(c: DragContext): DragRoute {
  if (c.scheme && DRAG_TO_CAMERA_SCHEMES.has(c.scheme)) return c.scriptCamera ? 'none' : 'orbit';
  if (c.riding && c.seatLock === 0) return 'pitch-only';
  return 'look';
}
