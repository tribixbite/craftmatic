#!/usr/bin/env bun
/**
 * Refresh the goldens inspection dashboard (`web/public/goldens/`) from the
 * latest pipeline artifacts + state.
 *
 * For each golden slug with artifacts under `output/pipeline/<slug>/`:
 *   • copies <slug>.print.glb / <slug>.scene.glb
 *   • renders iso / top-down / front PNGs from the schem via the SAME
 *     render-round used for VLM scoring (createGridRenderRound)
 *   • collects metrics (status, iou, defect score, synthesis path, lastRun)
 *     from output/pipeline-state.json — the dashboard previously hardcoded
 *     these and drifted stale.
 * Writes web/public/goldens/goldens.json which index.html fetches.
 *
 * Usage: bun scripts/refresh-goldens.ts [slug ...]   (default: all 5 goldens)
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseToGrid } from '../src/schem/parse.js';
import { createGridRenderRound } from '../src/pipeline/verify/default-render-round.js';

const projectRoot = resolve(import.meta.dir, '..');
const goldenDir = join(projectRoot, 'web/public/goldens');
const stateFile = join(projectRoot, 'output/pipeline-state.json');

const DEFAULT_SLUGS = ['flatiron', '240-highland', 'pennzoil', 'guggenheim', 'geisel'];
const slugs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SLUGS;

interface GoldenMeta {
  slug: string;
  address: string | null;
  status: string | null;
  synthesisPath: string | null;
  iou: number | null;
  defectScore: number | null;
  voxels: number | null;
  lastRun: string | null;
}

const state = existsSync(stateFile)
  ? (JSON.parse(readFileSync(stateFile, 'utf8')) as {
      addresses?: Record<string, {
        address?: string; status?: string; lastRun?: string;
        synthesisPath?: string | null;
        objective?: { footprintIoU?: number; voxelCount?: number } | null;
        defectScore?: { score?: number } | null;
      }>;
    }).addresses ?? {}
  : {};

mkdirSync(goldenDir, { recursive: true });
const out: GoldenMeta[] = [];
const views = ['iso', 'td', 'front'] as const;

for (const slug of slugs) {
  const srcDir = join(projectRoot, 'output/pipeline', slug);
  const schem = join(srcDir, `${slug}.schem`);
  if (!existsSync(schem)) {
    console.error(`skip ${slug}: no ${schem}`);
    continue;
  }
  for (const kind of ['print', 'scene'] as const) {
    const glb = join(srcDir, `${slug}.${kind}.glb`);
    if (existsSync(glb)) copyFileSync(glb, join(goldenDir, `${slug}.${kind}.glb`));
  }
  console.error(`rendering ${slug}…`);
  const grid = await parseToGrid(schem);
  const pngs = await createGridRenderRound(grid)(1);
  // render round order: iso, front, td, cutaway → map to dashboard names
  writeFileSync(join(goldenDir, `${slug}-iso.png`), pngs[0]);
  writeFileSync(join(goldenDir, `${slug}-front.png`), pngs[1]);
  writeFileSync(join(goldenDir, `${slug}-td.png`), pngs[2]);

  const rec = state[slug];
  out.push({
    slug,
    address: rec?.address ?? null,
    status: rec?.status ?? null,
    synthesisPath: rec?.synthesisPath ?? null,
    iou: rec?.objective?.footprintIoU ?? null,
    defectScore: rec?.defectScore?.score ?? null,
    voxels: rec?.objective?.voxelCount ?? null,
    lastRun: rec?.lastRun ?? null,
  });
  void views;
}

writeFileSync(join(goldenDir, 'goldens.json'), JSON.stringify(out, null, 2));
console.error(`wrote ${out.length} goldens → ${join(goldenDir, 'goldens.json')}`);
