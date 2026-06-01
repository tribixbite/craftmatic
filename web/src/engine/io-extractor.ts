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

import { extractFile } from './zip-utils';

const CANDIDATES = ['model.ldr', 'model2.ldr', 'modelv2.ldr'];

export async function extractIoLDraw(buffer: ArrayBuffer): Promise<string> {
  let fallback = '';
  for (const name of CANDIDATES) {
    try {
      const data = await extractFile(buffer, name, 'soho0909');
      const text = new TextDecoder('utf-8').decode(data);
      // A usable model has at least one part-reference line (type 1).
      if (/^\s*1\s/m.test(text)) return text;
      if (!fallback) fallback = text;
    } catch {
      // entry absent / decrypt failure — try the next candidate
    }
  }
  if (fallback) return fallback;
  throw new Error('No LDraw model found in .io archive');
}
