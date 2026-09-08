/**
 * Which sets could an even finer export cell (cellLDU 2 = 10 blocks per stud)
 * legally serve, and what would it cost?
 *
 * Prints, for each model, the auto plan and the cellLDU-2 plan against the
 * shipped caps (max(w,l) <= 640, h <= 320, <= 30M cells).
 *
 * Usage: bun scripts/_res_survey.ts <model.io> [...]
 */
import { readFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { planResolution, spanOfBricks, describePlan, type ResolutionChoice } from '../web/src/engine/schem-settings.ts';

for (const file of process.argv.slice(2)) {
  const b = readFileSync(file);
  const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  const bricks = parseLDraw(synthesizeLSynth(io.text).text);
  const span = spanOfBricks(bricks);
  const auto = planResolution(span, 'auto');
  const fine = planResolution(span, '2' as ResolutionChoice);
  console.log(`${file.split('/').pop()!.padEnd(22)} bricks=${String(bricks.length).padStart(5)} ` +
    `span=${span.x.toFixed(0)}x${span.y.toFixed(0)}x${span.z.toFixed(0)} LDU\n` +
    `   auto  → cell ${auto.cellLDU}: ${describePlan(auto)}\n` +
    `   10/stud → ${fine.requestedHonored ? 'ALLOWED' : 'refused'}: ${describePlan(fine)}`);
}
