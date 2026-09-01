/**
 * Extract the LDraw model text from a BrickLink Studio .io file.
 *
 * .io files are ZIP archives. Older exports are ZipCrypto-encrypted
 * (password "soho0909"); newer ones are unencrypted — extractFile() handles
 * both (it only decrypts entries whose encryption flag is set, so passing the
 * password is harmless for unencrypted entries).
 *
 * The archive contains several model variants:
 *   model.ldr    — Studio's LDraw export referencing standard .dat parts.
 *                  Studio aligns LDD/Studio geometry onto the LDraw library
 *                  correctly, so this is the geometrically-faithful model. Its
 *                  external part refs now resolve via the /ldraw-parts proxy
 *                  (full LDraw library), so it no longer needs inlined parts.
 *   model2.ldr   — historically a self-contained MPD with inlined subparts,
 *                  but newer exports leave its top section unparseable (0
 *                  bricks). Kept only as a fallback.
 *   modelv2.ldr  — Studio's custom type-11 format (not standard LDraw).
 *
 * Strategy: return the first candidate that actually contains brick reference
 * lines (`1 ...`). This fixes newer .io files (model.ldr) while still handling
 * older ones (model2.ldr) and keeps a last-resort fallback.
 */

import { extractFile, extractMatching } from './zip-utils';
import { BL_TO_LDRAW } from './bl-ldraw-map';

const CANDIDATES = ['model.ldr', 'model2.ldr', 'modelv2.ldr'];
const IO_PASSWORD = 'soho0909';

/**
 * Which colour-id system a model's type-1 lines use. NEVER conflate these —
 * LDraw 15 is White but Studio/BL 15 is Trans-Light Blue, so reading one
 * through the other's table turns white castle walls into light-blue glass
 * (the exact .schem export bug fixed here).
 */
export type LdrColorSpace = 'ldraw' | 'bl';

export interface ColorSpaceDetection {
  space: LdrColorSpace;
  /** Human-readable justification (surfaced in dev logs). */
  reason: string;
}

export interface IoModel {
  /** The LDraw model text (MPD/LDR). */
  text: string;
  /**
   * Studio's bundled part definitions from the archive's `CustomParts/` dir:
   * user-modified parts (`m<hash>_<date>_<time>.dat`), Studio-only parts, and
   * the exact primitives those parts need (incl. `p/48/...` hi-res variants).
   * Keyed by archive path relative to `CustomParts/` (e.g. `p/48/1-12edge.dat`,
   * `m3659da88_2019920_072931.dat`). Without these, sets with modified parts
   * (most large Technic vehicles) silently render with pieces missing.
   */
  customParts: Map<string, string>;
  /** Which archive entry `text` came from (e.g. `model.ldr`). */
  sourceEntry: string;
  /** Colour space of `text`'s type-1 colour ids, and why we think so. */
  colorSpace: LdrColorSpace;
  colorSpaceReason: string;
}

const TYPE1_RE = /^\s*1\s+(-?\d+)\s/;

/**
 * Histogram of type-1 line colour ids. Direct `0x…` colours and the `-1`
 * "inherit from parent" placeholder are excluded: `-1` is spelled identically
 * in both colour spaces (Studio's inlined sub-part refs are full of it) and
 * would otherwise swamp the signal.
 */
export function colorHistogram(text: string): Map<number, number> {
  const hist = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = TYPE1_RE.exec(line);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    if (id === -1) continue;
    hist.set(id, (hist.get(id) ?? 0) + 1);
  }
  return hist;
}

function overlap(a: Map<number, number>, b: Map<number, number>): number {
  let sum = 0;
  for (const [k, n] of a) sum += Math.min(n, b.get(k) ?? 0);
  return sum;
}

/**
 * Decide which colour space a chosen .io model entry uses.
 *
 * Studio writes the SAME model twice: `model.ldr` in standard LDraw colour ids
 * and `model2.ldr` in Studio/BrickLink ids. When both entries are present we
 * PROVE the pairing by histogram — BL→LDraw-mapping model2's counts should
 * reproduce model.ldr's counts almost exactly (verified on 21063: 939 white
 * bricks are BL 1 in model2.ldr and LDraw 15 in model.ldr, and 11/11 sampled
 * ids map through). With only one entry available we fall back to the
 * documented per-entry convention.
 *
 * Mirrors clego's `io_authenticity.detect_colorspace` (the proven reference).
 */
export function detectIoColorSpace(
  chosenEntry: string,
  chosenText: string,
  otherEntries: ReadonlyMap<string, string>,
): ColorSpaceDetection {
  // Per-entry convention: model.ldr is Studio's LDraw-space export; model2.ldr
  // (and modelv2.ldr) carry Studio/BrickLink ids.
  const conventional: LdrColorSpace = chosenEntry === 'model.ldr' ? 'ldraw' : 'bl';

  const ldrText = chosenEntry === 'model.ldr' ? chosenText : otherEntries.get('model.ldr');
  const blText = chosenEntry === 'model2.ldr' ? chosenText : otherEntries.get('model2.ldr');
  // Identical texts are NOT special-cased: their literal overlap is 1.0, which
  // the comparison below correctly reads as "one shared space" ⇒ LDraw.
  if (!ldrText || !blText) {
    return { space: conventional, reason: `entry-name convention (${chosenEntry}, no paired entry to compare)` };
  }

  const hLdr = colorHistogram(ldrText);
  const hBl = colorHistogram(blText);
  const total = [...hBl.values()].reduce((a, b) => a + b, 0);
  if (total === 0 || hLdr.size === 0) {
    return { space: conventional, reason: `entry-name convention (${chosenEntry}, no colour ids to compare)` };
  }

  const hBlMapped = new Map<number, number>();
  for (const [id, n] of hBl) {
    const mapped = BL_TO_LDRAW[id] ?? id;
    hBlMapped.set(mapped, (hBlMapped.get(mapped) ?? 0) + n);
  }

  const literal = overlap(hLdr, hBl) / total;
  const mapped = overlap(hLdr, hBlMapped) / total;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  if (mapped > literal + 0.05) {
    // model2 only matches model.ldr AFTER BL→LDraw mapping ⇒ the two entries
    // really are in different spaces, so the convention holds.
    return {
      space: conventional,
      reason: `paired-histogram confirmed (BL→LDraw overlap ${pct(mapped)} > literal ${pct(literal)})`,
    };
  }
  if (literal > mapped + 0.05) {
    // Both entries already agree literally ⇒ they share one space, and since
    // model.ldr is LDraw by definition, the chosen text is LDraw either way.
    return {
      space: 'ldraw',
      reason: `both entries share one colour space (literal overlap ${pct(literal)} > mapped ${pct(mapped)})`,
    };
  }
  return { space: conventional, reason: `entry-name convention (${chosenEntry}, histograms inconclusive)` };
}

/** Read every candidate model entry that decrypts, keyed by entry name. */
async function readCandidates(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dec = new TextDecoder('utf-8');
  for (const name of CANDIDATES) {
    try {
      out.set(name, dec.decode(await extractFile(buffer, name, IO_PASSWORD)));
    } catch {
      // entry absent / decrypt failure — skip it
    }
  }
  return out;
}

/** Pick the first candidate that actually contains type-1 brick refs. */
function chooseEntry(entries: ReadonlyMap<string, string>): { entry: string; text: string } {
  let fallback: { entry: string; text: string } | null = null;
  for (const name of CANDIDATES) {
    const text = entries.get(name);
    if (text === undefined) continue;
    if (/^\s*1\s/m.test(text)) return { entry: name, text };
    if (!fallback) fallback = { entry: name, text };
  }
  if (fallback) return fallback;
  throw new Error('No LDraw model found in .io archive');
}

export async function extractIoLDraw(buffer: ArrayBuffer): Promise<string> {
  return chooseEntry(await readCandidates(buffer)).text;
}

/**
 * Extract the model text AND the archive's CustomParts/*.dat definitions.
 * Prefer this over extractIoLDraw for rendering — Studio references its
 * bundled custom parts by name from the model, and they exist nowhere else.
 */
export async function extractIoModel(buffer: ArrayBuffer): Promise<IoModel> {
  const entries = await readCandidates(buffer);
  const { entry: sourceEntry, text } = chooseEntry(entries);
  // Which colour table the caller must use is a property of the CHOSEN ENTRY,
  // not of the ".io" extension — modern Studio exports win on model.ldr
  // (LDraw ids) while older ones fall through to model2.ldr (Studio/BL ids).
  const detection = detectIoColorSpace(sourceEntry, text, entries);
  const customParts = new Map<string, string>();
  const raw = await extractMatching(
    buffer,
    name => /^customparts\/.*\.dat$/i.test(name.replace(/\\/g, '/')),
    IO_PASSWORD,
  );
  const dec = new TextDecoder('utf-8');
  for (const [name, data] of raw) {
    const rel = name.replace(/\\/g, '/').replace(/^customparts\//i, '');
    customParts.set(rel, dec.decode(data));
  }
  return {
    text,
    customParts,
    sourceEntry,
    colorSpace: detection.space,
    colorSpaceReason: detection.reason,
  };
}
