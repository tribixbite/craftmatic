/**
 * Parse a LEGO Digital Designer .lxf file → ParsedBrick[].
 *
 * LXF is a plain ZIP archive containing IMAGE100.LXFML (XML).
 * LXFML structure:
 *   <LXFML>
 *     <Bricks>
 *       <Brick designID="3001">
 *         <Part materials="21,...">
 *           <Bone transformation="r00,r01,...,tx,ty,tz"/>
 *         </Part>
 *       </Brick>
 *     </Bricks>
 *   </LXFML>
 *
 * Coordinate system: LDD uses cm units, Y-up.
 * Conversion: multiply by 25 to get LDU (1cm = 25 LDU), negate Y (LDraw is Y-down).
 */

import { extractFile } from './zip-utils';
import { lddToLDraw } from './ldd-colors';
import type { ParsedBrick } from './ldraw-parser';

/** 1 cm = 25 LDraw units (1 stud = 0.8cm = 20 LDU → 1cm = 25 LDU) */
const CM_TO_LDU = 25;

export async function parseLxf(buffer: ArrayBuffer): Promise<ParsedBrick[]> {
  const xmlBytes = await extractFile(buffer, 'IMAGE100.LXFML');
  const xmlText = new TextDecoder('utf-8').decode(xmlBytes);

  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) throw new Error(`LXFML parse error: ${parserError.textContent?.slice(0, 120)}`);

  const bricks: ParsedBrick[] = [];

  for (const brick of doc.querySelectorAll('Brick')) {
    const designID = brick.getAttribute('designID') ?? '3001';
    const part = `${designID}.dat`;

    const partEl = brick.querySelector('Part');
    const materialsAttr = partEl?.getAttribute('materials') ?? '';
    const materialId = parseInt(materialsAttr.split(',')[0], 10) || 194;
    const color = lddToLDraw(materialId);

    const bone = brick.querySelector('Bone');
    if (!bone) continue;

    const tf = bone.getAttribute('transformation');
    if (!tf) continue;

    const vals = tf.split(',').map(Number);
    if (vals.length < 12) continue;

    // Last 3 values are translation in cm
    const tx = vals[9];
    const ty = vals[10];
    const tz = vals[11];

    bricks.push({
      color,
      x: tx * CM_TO_LDU,
      y: -ty * CM_TO_LDU, // LDD Y-up → LDraw Y-down
      z: tz * CM_TO_LDU,
      part,
    });
  }

  if (bricks.length === 0) throw new Error('No brick placements found in LXFML');
  return bricks;
}
