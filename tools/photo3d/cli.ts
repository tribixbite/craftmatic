/**
 * Photos of a real build -> a coloured GLB (BIZ-39 / WP B15).
 *
 *   bun tools/photo3d/cli.ts --front a.jpg --left b.jpg --back c.jpg --out x.glb
 *   bun tools/photo3d/cli.ts --single a.jpg --out x.glb [--model trellis2]
 *
 * Needs a ComfyUI at --url (default http://127.0.0.1:8188) started from C:/git/comfyui-3d with the Pixal3D /
 * TRELLIS.2 weights; see tools/photo3d/LICENSES.md. Writes the GLB plus `<out>.report.json` (timings, mesh stats).
 */
import { parseArgs } from 'node:util';
import { DEFAULT_URL } from './comfy';
import { parseGenOptions, SAMPLERS, VIEWS } from './graphs';
import { photosToGlb, photoToGlb, writeReport, type PipelineReport } from './pipeline';

const USAGE = `usage: bun tools/photo3d/cli.ts (--front F [--left L] [--back B] [--right R] | --single P) --out OUT.glb
  --url URL            ComfyUI base URL (default ${DEFAULT_URL})
  --no-mirror          do not mirror --left into a missing --right
  --model pixal3d|trellis2   single-photo model (default pixal3d)
  --seed N --faces N --detail N --remesh N --smooth N --steps X --texture N
  --guidance X --tex-guidance X --shift X --sampler ${SAMPLERS.join('|')} --min-piece X
  --timeout-s N        overall deadline of one ComfyUI job (default 3600)
  --max-edge N         cap a photo's long edge before upload (default 2048)`;

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      front: { type: 'string' }, left: { type: 'string' }, back: { type: 'string' }, right: { type: 'string' },
      single: { type: 'string' }, out: { type: 'string' }, url: { type: 'string' },
      'no-mirror': { type: 'boolean' }, model: { type: 'string' },
      seed: { type: 'string' }, faces: { type: 'string' }, detail: { type: 'string' }, remesh: { type: 'string' },
      smooth: { type: 'string' }, steps: { type: 'string' }, texture: { type: 'string' },
      guidance: { type: 'string' }, 'tex-guidance': { type: 'string' }, shift: { type: 'string' },
      sampler: { type: 'string' }, 'min-piece': { type: 'string' },
      'timeout-s': { type: 'string' }, 'max-edge': { type: 'string' }, help: { type: 'boolean' },
    },
  });
  if (values.help || !values.out || (!values.single && !values.front)) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  if (values.single && values.front) {
    console.error('give either --single or --front/--left/--back/--right, not both');
    return 2;
  }
  const gen = parseGenOptions({
    seed: values.seed, faces: values.faces, detail: values.detail, remesh: values.remesh, smooth: values.smooth,
    steps: values.steps, texture: values.texture, guidance: values.guidance, texGuidance: values['tex-guidance'],
    shift: values.shift, sampler: values.sampler, minPiece: values['min-piece'], model: values.model,
  });
  const options = {
    gen,
    mirrorRight: !values['no-mirror'],
    maxEdge: values['max-edge'] ? Number(values['max-edge']) : undefined,
    comfy: {
      ...(values.url ? { url: values.url } : {}),
      ...(values['timeout-s'] ? { jobTimeoutMs: Number(values['timeout-s']) * 1000 } : {}),
    },
    log: (line: string) => console.error(line),
  };
  const report: PipelineReport = values.single
    ? await photoToGlb(values.single, values.out, options)
    : await photosToGlb(
        Object.fromEntries(VIEWS.filter((v) => values[v]).map((v) => [v, values[v] as string])),
        values.out,
        options,
      );
  const reportPath = await writeReport(report);
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
  return report.mesh.closed ? 0 : 3; // 3: generated, but the mesh is not closed
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
