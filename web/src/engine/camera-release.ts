/**
 * Giving a player their own view back, whatever happened to the runtime that took it.
 *
 * Every craftmatic runtime that sets a script camera on a player (the vehicle chase / cockpit camera, the coaster's
 * rider camera, the pinball seat) keeps its riders in MEMORY and clears the camera when it sees the rider leave.
 * Nothing else ever clears it: a runtime that restarts while a camera is set (the world reloaded mid-ride, a pack
 * re-imported, a script that faulted) has forgotten the rider, and the camera stays where it was set, locked in
 * place, for good - the user's "when dismounting vehicles the camera never goes back to the player, it stays locked
 * in one location" (2026-10-18, VEH-19). So each such runtime also TAGS the player (`CAMERA_OWNER_TAG`, a tag
 * persists with the player) and sweeps (`releaseOrphanCameras`, every `CAMERA_SWEEP_TICKS`): a tagged player who
 * rides nothing has the camera cleared, the tag removed, and the invisibility the runtimes give a rider whose camera
 * stands at the eye lifted (`hiddenTag`, bedrock-ride-hop.ts `HOP_TAGS.hidden`). A runtime's own release still runs
 * first; the sweep sends the clear again up to a second later, after any camera ease has finished.
 *
 * Serialised into the packs (`releaseOrphanCameras.toString()`): it may reference nothing outside its own body.
 */

/** The tag a craftmatic runtime puts on a player it gives a script camera. */
export const CAMERA_OWNER_TAG = 'craftmatic_camera';

/** How often each camera runtime sweeps for players it (or another runtime, or an earlier run) left a camera on. */
export const CAMERA_SWEEP_TICKS = 20;

/**
 * Clear the camera of every player carrying `tags.camera` who rides nothing, and take the tag off; lift the
 * invisibility of one carrying `tags.hidden` too. Returns how many players it released. A player on a mount is
 * left alone: that mount's runtime owns the view (a coaster car, a vehicle, the pinball seat - all are rides).
 */
export function releaseOrphanCameras(world: any, tags: { camera: string; hidden?: string }): number {
  let players: any[] = [];
  try { players = world.getPlayers({ tags: [tags.camera] }) || []; } catch { return 0; }
  let released = 0;
  for (const player of players) {
    if (!player) continue;
    let riding: any;
    try { riding = player.getComponent('minecraft:riding')?.entityRidingOn; } catch { riding = undefined; }
    if (riding) continue;
    try { player.camera.clear(); } catch { /* no camera */ }
    try { player.removeTag(tags.camera); } catch { /* gone */ }
    if (tags.hidden) {
      let hidden = false;
      try { hidden = player.hasTag(tags.hidden); } catch { /* no tags */ }
      if (hidden) {
        try { player.removeEffect('invisibility'); } catch { /* none */ }
        try { player.removeTag(tags.hidden); } catch { /* gone */ }
      }
    }
    released++;
  }
  return released;
}
