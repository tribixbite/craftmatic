/**
 * What a player's hands are doing this tick, in the phone's terms: the move
 * stick (forward/back, strafe), Jump and Sneak held, drags on the screen, and
 * where the camera looks. The input module (`touch.ts`, `drag.ts`,
 * `screen.ts`) turns scenario actions into this state; the physics and the
 * script host (`player.inputInfo`) read it.
 *
 * Sneak has two modes:
 *   - `hold` (the default, every scenario that predates the toggle): sneak is
 *     on while held, as a keyboard's shift;
 *   - `toggle` (the phone's touch sneak button, quirk `touch-sneak-toggle`):
 *     each PRESS flips it, a release changes nothing, so a child who pressed
 *     Sneak to leave a seat walks on sneaking until pressing it again (Pixel
 *     30j: 10326 Door 3's walk-in stopped 0.24 before the leaf).
 * In both modes every press is a rising edge: the dismount (quirk
 * `sneak-dismounts`).
 *
 * A drag is queued here (`drag`) and applied by the players system at the
 * start of the next tick, routed by the player's control scheme
 * (`scheme.ts`, quirk `control-scheme-drag-to-camera`).
 */

/** A player's held controls. */
export interface PlayerControls {
  /** The move stick: +forward / -back, +left / -right strafe, each -1..1 (the phone's joystick). */
  forward: number;
  strafe: number;
  jump: boolean;
  /** Whether the player is sneaking now (in `toggle` mode: the latched state, not the finger). */
  sneak: boolean;
  sprint: boolean;
  /**
   * AUTO-JUMP on (Bedrock's touch default, quirk `auto-jump`): an obstacle ahead within 1.2 is jumped without
   * Jump pressed (sim/physics/body.ts `autoJumpWanted`). Off unless a scenario turns it on (`walkLine`'s
   * `autoJump`), so every walk that predates it is unchanged.
   */
  autoJump?: boolean;
}

export const IDLE_CONTROLS: PlayerControls = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };

/** How the sneak control behaves: held (a keyboard) or toggled by each press (the touch button). */
export type SneakMode = 'hold' | 'toggle';

/** A drag on the screen, in degrees of look it asks for (+yaw turns right, +pitch looks down). */
export interface DragDelta { yawDeg: number; pitchDeg: number }

/** Per-player controls, keyed by the engine entity id. */
export class ControlState {
  private readonly byPlayer = new Map<string, PlayerControls>();
  /** Sneak pressed this tick (a rising edge): the dismount. */
  private readonly sneakEdge = new Set<string>();
  private readonly sneakModes = new Map<string, SneakMode>();
  /** In `toggle` mode: whether the button's last press left sneak on. */
  private readonly sneakLatched = new Map<string, boolean>();
  /** In `toggle` mode: whether the finger is down on the sneak button (a `set({ sneak: true })` not yet released). */
  private readonly sneakFinger = new Map<string, boolean>();
  /** Drags not yet applied (summed), applied by the players system at the next tick. */
  private readonly pendingDrag = new Map<string, DragDelta>();

  get(playerId: string): PlayerControls {
    const c = this.byPlayer.get(playerId) ?? IDLE_CONTROLS;
    return this.sneakMode(playerId) === 'toggle' ? { ...c, sneak: this.sneakLatched.get(playerId) ?? false } : c;
  }

  /**
   * Set controls. `sneak: true` is a press of the sneak control: in `hold` mode it stays on until
   * `sneak: false`; in `toggle` mode it flips the latched state and the matching `sneak: false` (the release)
   * changes nothing. Either way a press is a dismount edge.
   */
  set(playerId: string, c: Partial<PlayerControls>): void {
    const prev = this.byPlayer.get(playerId) ?? IDLE_CONTROLS;
    const next = { ...prev, ...c };
    if (this.sneakMode(playerId) === 'toggle') {
      if (c.sneak !== undefined) {
        const down = this.sneakFinger.get(playerId) ?? false;
        if (c.sneak && !down) this.sneakToggle(playerId);
        this.sneakFinger.set(playerId, c.sneak);
      }
    } else if (next.sneak && !prev.sneak) this.sneakEdge.add(playerId);
    this.byPlayer.set(playerId, next);
  }

  /** Whether sneak went down since the last call (consumed). */
  takeSneakEdge(playerId: string): boolean { return this.sneakEdge.delete(playerId); }

  /** The player's sneak mode (default `hold`). */
  sneakMode(playerId: string): SneakMode { return this.sneakModes.get(playerId) ?? 'hold'; }

  /**
   * Switch a player's sneak control to `hold` or `toggle` (the touch button, quirk `touch-sneak-toggle`). The
   * current sneak state carries over, so switching never presses anything.
   */
  setSneakMode(playerId: string, mode: SneakMode): void {
    const now = this.get(playerId).sneak;
    this.sneakModes.set(playerId, mode);
    if (mode === 'toggle') { this.sneakLatched.set(playerId, now); this.sneakFinger.set(playerId, false); }
    else this.byPlayer.set(playerId, { ...(this.byPlayer.get(playerId) ?? IDLE_CONTROLS), sneak: now });
  }

  /**
   * ONE press of the touch sneak button (quirk `touch-sneak-toggle`): sneak flips on or off and the press is a
   * dismount edge. In `hold` mode the same call is a tap of the key: an edge, and sneak is left as it was.
   * Returns whether the player is sneaking after the press.
   */
  sneakToggle(playerId: string): boolean {
    this.sneakEdge.add(playerId);
    if (this.sneakMode(playerId) !== 'toggle') return this.get(playerId).sneak;
    const on = !(this.sneakLatched.get(playerId) ?? false);
    this.sneakLatched.set(playerId, on);
    return on;
  }

  /**
   * A drag on the screen, in degrees of look (`drag.ts` `dragPixels` converts a finger's pixels). Drags queued in
   * one tick add up; the players system routes the sum by the control scheme at the start of the next tick.
   */
  drag(playerId: string, d: DragDelta): void {
    const p = this.pendingDrag.get(playerId) ?? { yawDeg: 0, pitchDeg: 0 };
    this.pendingDrag.set(playerId, { yawDeg: p.yawDeg + d.yawDeg, pitchDeg: p.pitchDeg + d.pitchDeg });
  }

  /** The drag queued since the last call (consumed), or undefined. */
  takeDrag(playerId: string): DragDelta | undefined {
    const d = this.pendingDrag.get(playerId);
    this.pendingDrag.delete(playerId);
    return d;
  }
}

/**
 * The stick in WORLD axes for a look yaw: forward is the view's horizontal
 * direction (yaw 0 looks +Z), a positive strafe is to the player's left.
 */
export function stickToWorld(c: Pick<PlayerControls, 'forward' | 'strafe'>, yawDeg: number): { x: number; z: number } {
  const y = yawDeg * Math.PI / 180;
  const fx = -Math.sin(y), fz = Math.cos(y);
  // Left of a player looking +Z is +X (east): the forward vector turned +90 degrees about Y.
  const lx = fz, lz = -fx;
  return { x: fx * c.forward + lx * c.strafe, z: fz * c.forward + lz * c.strafe };
}
