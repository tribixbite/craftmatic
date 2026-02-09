/**
 * Static HTML export — generates a self-contained HTML file
 * with embedded Three.js viewer and schematic data (with textures).
 */

import { writeFileSync } from 'node:fs';
import { BlockGrid } from '../schem/types.js';
import { serializeForViewerTextured } from './three-scene.js';
import { generateViewerHTML } from './server.js';

/**
 * Export a standalone HTML file with embedded 3D viewer.
 * The file loads Three.js from CDN and embeds the schematic
 * data with real texture PNGs as base64 data URIs.
 */
export async function exportHTML(grid: BlockGrid, outputPath: string): Promise<void> {
  const viewerData = await serializeForViewerTextured(grid);
  const html = generateViewerHTML(viewerData);
  writeFileSync(outputPath, html, 'utf-8');
}
