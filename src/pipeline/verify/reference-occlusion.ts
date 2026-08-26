/**
 * Occlusion verdicts for the reference images the consensus scorer sees.
 *
 * The scorer compares renders against `output/reference-data/<slug>/*.jpg`.
 * When those photos show FOLIAGE rather than the building, the VLM has
 * nothing to match and returns near-zero on a perfectly good build —
 * 240-highland sits behind dense evergreens and scored 0/0/0/0 at IoU 1.00,
 * defect 10.0, which then drove the loop to prescribe facade work four
 * attempts running.
 *
 * The capture path already sniffs occlusion for the panes it fetches, but a
 * reference directory accumulates files across runs: a capture that returns
 * two facades leaves the other two panes on disk from an older run, unjudged.
 * Judging the FILES (not just the live captures) closes that gap and also
 * covers human-curated references dropped in by hand.
 *
 * The `veg ≥ 0.30 ⇒ trees` threshold is the same one
 * `streetview.ts:classifyOcclusion` applies to live captures, so a pane gets
 * the same verdict whichever path judged it.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImageToRgba, sniffPixels } from '../capture/sv-sniff.js';

/** Vegetation fraction at or above which a pane is considered tree-occluded. */
export const VEG_OCCLUSION_MIN = 0.30;

export type ReferenceOcclusion = 'trees' | 'none';

/** Manifest shape persisted as `references.json` beside the images. */
export interface ReferenceManifest {
  occlusion: Record<string, string>;
}

/**
 * Classify a single encoded reference image. Returns `'none'` when the image
 * cannot be decoded — an unreadable file must not silently become a reason to
 * stop scoring an address.
 */
export async function classifyReferenceBytes(bytes: Uint8Array): Promise<ReferenceOcclusion> {
  // NOTE the deliberately narrow catch. An earlier version wrapped the whole
  // body in `catch { return 'none' }` and silently reported every pane as
  // clear when the field name was wrong (`res.veg` — it is
  // `res.ratios.veg`). That is the failure mode this module exists to
  // prevent, reproduced inside it: a classification that could not be made,
  // returned as a confident verdict. Only DECODE failure is tolerated; a
  // programming error must surface.
  let dec: { pixels: Uint8Array; width: number; height: number };
  try {
    dec = await decodeImageToRgba(bytes);
  } catch {
    return 'none'; // unreadable file must not become a reason to stop scoring
  }
  const res = sniffPixels(dec.pixels, dec.width, dec.height, 4);
  return res.ratios.veg >= VEG_OCCLUSION_MIN ? 'trees' : 'none';
}

/**
 * Ensure every street-level pane in `refDir` carries an occlusion verdict,
 * sniffing any that lack one and persisting the result.
 *
 * Existing verdicts are never overwritten: they came from the live capture
 * (which had the un-recompressed pixels) or from a human. Satellite is not
 * judged — a top-down crop is not tree-occluded the way a street pano is.
 *
 * Returns the complete verdict map.
 */
export async function ensureOcclusionManifest(
  refDir: string,
  svPaneNames: readonly string[],
): Promise<Record<string, string>> {
  if (!existsSync(refDir)) return {};
  const manifestPath = join(refDir, 'references.json');

  let occlusion: Record<string, string> = {};
  if (existsSync(manifestPath)) {
    try {
      occlusion = (JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<ReferenceManifest>)
        .occlusion ?? {};
    } catch {
      occlusion = {};
    }
  }

  const present = new Set(readdirSync(refDir));
  let added = 0;
  for (const name of svPaneNames) {
    if (!present.has(name) || occlusion[name] !== undefined) continue;
    occlusion[name] = await classifyReferenceBytes(new Uint8Array(readFileSync(join(refDir, name))));
    added++;
  }
  if (added > 0) {
    writeFileSync(manifestPath, JSON.stringify({ occlusion }, null, 2));
  }
  return occlusion;
}
