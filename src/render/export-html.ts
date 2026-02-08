/**
 * Static HTML export — generates a self-contained HTML file
 * with embedded Three.js viewer and schematic data.
 */

import { writeFileSync } from 'node:fs';
import { BlockGrid } from '../schem/types.js';
import { serializeForViewer } from './three-scene.js';
import { generateViewerHTML } from './server.js';

/**
 * Export a standalone HTML file with embedded 3D viewer.
 * The file loads Three.js from CDN and embeds the schematic
 * data directly as JSON in a script tag.
 */
export function exportHTML(grid: BlockGrid, outputPath: string): void {
  const viewerData = serializeForViewer(grid);
  const html = generateViewerHTML(viewerData);
  writeFileSync(outputPath, html, 'utf-8');
}
