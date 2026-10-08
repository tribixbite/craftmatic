/**
 * What a player's hands are doing this tick, in the phone's terms: the move
 * stick (forward/back, strafe), Jump and Sneak held, and where the camera
 * looks. The input module (`touch.ts`) turns scenario actions into this state;
 * the physics and the script host (`player.inputInfo`) read it.
 */

/** A player's held controls. */
export interface PlayerControls {
  /** The move stick: +forward / -back, +left / -right strafe, each -1..1 (the phone's joystick). */
  forward: number;
  strafe: number;
  jump: boolean;
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

/** Per-player controls, keyed by the engine entity id. */
export class ControlState {
  private readonly byPlayer = new Map<string, PlayerControls>();
  /** Sneak pressed this tick (a rising edge): the dismount. */
  private readonly sneakEdge = new Set<string>();

  get(playerId: string): PlayerControls { return this.byPlayer.get(playerId) ?? IDLE_CONTROLS; }

  set(playerId: string, c: Partial<PlayerControls>): void {
    const prev = this.get(playerId);
    const next = { ...prev, ...c };
    if (next.sneak && !prev.sneak) this.sneakEdge.add(playerId);
    this.byPlayer.set(playerId, next);
  }

  /** Whether sneak went down since the last call (consumed). */
  takeSneakEdge(playerId: string): boolean { return this.sneakEdge.delete(playerId); }
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
