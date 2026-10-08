/**
 * The scenario steps of the input module: a touch drag, a press of the touch
 * sneak button, a tap at a point of a phone screen, and the sneak mode. Any
 * scenario runner that is handed `INPUT_HANDLERS` (the CLI merges them into
 * every scenario set) can use them:
 *
 *   { kind: 'drag', dx, dy, ticks? }        a finger dragged dx, dy raw pixels
 *                                           over `ticks` (default 1), evenly
 *                                           (`drag.ts` `dragPixels`); or
 *   { kind: 'drag', yawDeg, pitchDeg, ticks? }  the same in degrees of look;
 *   { kind: 'sneakToggle' }                 one press of the touch sneak
 *                                           button (quirk `touch-sneak-toggle`);
 *   { kind: 'sneakMode', mode }             `hold` or `toggle` from now on;
 *   { kind: 'tapScreen', x, y, viewport? }  a tap at raw pixel (x, y) of the
 *                                           phone screen (`pixel` default, or
 *                                           `saga`), or { u, v } in 0..1;
 *                                           `expect` names a type pattern the
 *                                           pick must hit (else a violation).
 */

import type { AnyStep, StepContext, StepHandler } from '../scenario/types.js';
import { dragPixels } from './drag.js';
import { PIXEL_VIEWPORT, SAGA_VIEWPORT, tapScreen, type ScreenPick, type Viewport } from './screen.js';

/** A viewport by name (`pixel`, `saga`). */
export function viewportNamed(name: unknown): Viewport {
  return name === 'saga' ? SAGA_VIEWPORT : PIXEL_VIEWPORT;
}

/** Queue a drag spread evenly over `ticks` ticks, running them (pixels when dx/dy are given, else degrees). */
export async function dragOver(ctx: StepContext, d: { dx?: number; dy?: number; yawDeg?: number; pitchDeg?: number; ticks?: number }): Promise<void> {
  const ticks = Math.max(1, Math.round(d.ticks ?? 1));
  for (let t = 0; t < ticks; t++) {
    if (d.dx !== undefined || d.dy !== undefined) dragPixels(ctx.sim.controls, ctx.player.id, (d.dx ?? 0) / ticks, (d.dy ?? 0) / ticks);
    else ctx.sim.controls.drag(ctx.player.id, { yawDeg: (d.yawDeg ?? 0) / ticks, pitchDeg: (d.pitchDeg ?? 0) / ticks });
    await ctx.run(1);
  }
}

/** A tap at a screen point through the camera the player sees, recorded in `state.lastScreenTap`. */
export function screenTap(ctx: StepContext, point: { x: number; y: number }, viewport: Viewport): ScreenPick {
  const r = tapScreen(ctx.sim.engine, ctx.player, point, viewport, ctx.sim.host.playerState(ctx.player).camera);
  ctx.state['lastScreenTap'] = { point, viewport: viewport.name, camera: r.camera, entity: r.entity?.typeId, entityId: r.entity?.id, blockedBy: r.blockedBy, outOfReach: r.outOfReach, distance: r.distance };
  return r;
}

/** The input module's step handlers. */
export const INPUT_HANDLERS: Record<string, StepHandler> = {
  async drag(step: AnyStep, ctx: StepContext) {
    await dragOver(ctx, step as { dx?: number; dy?: number; yawDeg?: number; pitchDeg?: number; ticks?: number });
  },
  async sneakToggle(_step: AnyStep, ctx: StepContext) {
    const on = ctx.sim.controls.sneakToggle(ctx.player.id);
    ctx.note(`sneak button pressed: sneaking ${on ? 'ON' : 'OFF'} (${ctx.sim.controls.sneakMode(ctx.player.id)} mode)`);
    await ctx.run(1);
  },
  async sneakMode(step: AnyStep, ctx: StepContext) {
    ctx.sim.controls.setSneakMode(ctx.player.id, step['mode'] === 'toggle' ? 'toggle' : 'hold');
  },
  async tapScreen(step: AnyStep, ctx: StepContext) {
    const vp = viewportNamed(step['viewport']);
    const x = typeof step['x'] === 'number' ? step['x'] : Number(step['u'] ?? 0.5) * vp.width;
    const y = typeof step['y'] === 'number' ? step['y'] : Number(step['v'] ?? 0.5) * vp.height;
    const r = screenTap(ctx, { x, y }, vp);
    const want = step['expect'];
    if (want !== undefined) {
      const re = want instanceof RegExp ? want : new RegExp(String(want));
      if (!r.entity || !re.test(r.entity.typeId)) ctx.violate({ invariant: 'tap-screen-hits', message: `a tap at (${Math.round(x)}, ${Math.round(y)}) on the ${vp.name} screen picked ${r.entity?.typeId ?? r.blockedBy ?? (r.outOfReach ? `${r.outOfReach.entity} out of reach (${r.outOfReach.eyeDistance} blocks)` : 'nothing')}, not ${re.source}`, evidence: { ...(ctx.state['lastScreenTap'] as object) } });
    }
    await ctx.run(2);
  },
};
