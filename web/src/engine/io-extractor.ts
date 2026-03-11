/**
 * Extract the LDraw model text from a BrickLink Studio .io file.
 * .io files are ZipCrypto-encrypted ZIP archives (password: "soho0909").
 * The archive contains:
 *   model.ldr  — external-ref LDraw (references .dat part files not bundled)
 *   model2.ldr — fully self-contained MPD with all subpart geometry inlined
 * We use model2.ldr to get the complete model without missing part files.
 */

import { extractFile } from './zip-utils';

export async function extractIoLDraw(buffer: ArrayBuffer): Promise<string> {
  const data = await extractFile(buffer, 'model2.ldr', 'soho0909');
  return new TextDecoder('utf-8').decode(data);
}
