/**
 * Parts that ship IN THE BOX but are not part of the model: the brick
 * separator. LEGO's digital building instructions place one beside the
 * finished model, so a converted source carries it - 877 placements in 868
 * of clego's DbixConvV3 files (2026-10-01). Exported as model content it lies
 * on the ground beside the build: the orange piece on the grass outside
 * 10788's dollhouse in the user's shot of round 30i, and the orange post in
 * front of 11374's seated view (`pinball-table.ts` already set that one aside).
 *
 * Matched by mould id through `partStem` (an embedded `<set> - 630.dat` is the
 * same tool), never by description, so a part merely NAMED like a tool is not
 * dropped. The ids are LDraw's: 4654 (the first separator, 1990s), 630 (the
 * 2012 one) and 96874 (with the top axle, current).
 */
import { partStem } from './part-id.js';

/** LDraw mould ids of the brick separator, every generation. */
export const BUILD_TOOL_PARTS: ReadonlySet<string> = new Set(['4654', '630', '96874']);

/** Whether a placed part is a build tool (a brick separator), not model content. */
export function isBuildTool(part: string): boolean {
  return BUILD_TOOL_PARTS.has(partStem(part));
}

/**
 * The placements of `bricks` without the build tools, and how many were left
 * out. Returns the SAME array when there is nothing to remove, so callers that
 * key caches on the brick list keep their identity.
 */
export function withoutBuildTools<T extends { part: string }>(bricks: T[]): { bricks: T[]; removed: number } {
  const kept = bricks.filter(b => !isBuildTool(b.part));
  return kept.length === bricks.length ? { bricks, removed: 0 } : { bricks: kept, removed: bricks.length - kept.length };
}
