/**
 * CLI entry point for craftmatic.
 * Provides commands for parsing, rendering, generating, and viewing schematics.
 */

import { Command } from 'commander';
import { writeFileSync, existsSync } from 'node:fs';
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import ora from 'ora';
import { parseSchematic, parseToGrid } from './schem/parse.js';
import { writeSchematic } from './schem/write.js';
import { generateStructure } from './gen/generator.js';
import { renderFloorDetail, renderCutawayIso, renderExterior } from './render/png-renderer.js';
import { exportHTML } from './render/export-html.js';
import { startViewerServer, startWebAppServer } from './render/server.js';
import type { SchematicInfo, GenerationOptions, RoomType, StyleName, StructureType } from './types/index.js';

const program = new Command();

program
  .name('craftmatic')
  .description('Minecraft schematic toolkit — parse, generate, render, and convert .schem files')
  .version('0.2.1')
  .enablePositionalOptions();

// ─── Default command: open file with auto-detect ─────────────────────────────

program
  .argument('[file]', 'Schematic file to open')
  .option('--png', 'Render 2D PNGs')
  .option('--3d', 'Open 3D viewer')
  .option('--html [output]', 'Export standalone HTML')
  .option('--port <port>', 'Dev server port', '3000')
  .option('--no-open', 'Don\'t auto-open browser')
  .action(async (file: string | undefined, opts: Record<string, unknown>) => {
    if (!file) {
      // No file — show summary and launch local web app
      printBanner();
      const port = parseInt(opts['port'] as string ?? '3000', 10);
      const open = opts['open'] !== false;
      await launchWebApp(port, open);
      return;
    }
    if (!existsSync(file)) {
      console.error(chalk.red(`File not found: ${file}`));
      process.exit(1);
    }

    const hasPng = opts['png'] as boolean;
    const has3d = opts['3d'] as boolean;
    const hasHtml = opts['html'] as string | boolean | undefined;

    // Default: render PNGs + open 3D viewer
    if (!hasPng && !has3d && !hasHtml) {
      await renderCommand(file);
      await viewCommand(file, { port: opts['port'] as string });
      return;
    }

    if (hasPng) await renderCommand(file);
    if (has3d) await viewCommand(file, { port: opts['port'] as string });
    if (hasHtml) {
      const output = typeof hasHtml === 'string' ? hasHtml : file.replace(/\.schem$/, '.html');
      await exportCommand(file, output);
    }
  });

// ─── info command ────────────────────────────────────────────────────────────

program
  .command('info <file>')
  .description('Print schematic metadata')
  .action(async (file: string) => {
    const spinner = ora('Parsing schematic...').start();
    try {
      const data = await parseSchematic(file);
      const grid = (await import('./schem/parse.js')).schematicToGrid(data);
      spinner.stop();

      const info: SchematicInfo = {
        filename: basename(file),
        version: data.version,
        dataVersion: data.dataVersion,
        width: data.width,
        height: data.height,
        length: data.length,
        totalBlocks: data.width * data.height * data.length,
        nonAirBlocks: grid.countNonAir(),
        paletteSize: data.palette.size,
        blockEntityCount: data.blockEntities.length,
      };

      console.log(chalk.bold('\nSchematic Info'));
      console.log(`  File:           ${chalk.cyan(info.filename)}`);
      console.log(`  Version:        ${info.version}`);
      console.log(`  Data Version:   ${info.dataVersion}`);
      console.log(`  Dimensions:     ${chalk.yellow(`${info.width} x ${info.height} x ${info.length}`)} (W x H x L)`);
      console.log(`  Total Voxels:   ${info.totalBlocks.toLocaleString()}`);
      console.log(`  Non-air Blocks: ${chalk.green(info.nonAirBlocks.toLocaleString())}`);
      console.log(`  Palette Size:   ${info.paletteSize}`);
      console.log(`  Block Entities: ${info.blockEntityCount}`);

      // Show palette summary
      console.log(chalk.bold('\nPalette (top 20):'));
      const paletteCounts = new Map<string, number>();
      for (let y = 0; y < data.height; y++) {
        for (let z = 0; z < data.length; z++) {
          for (let x = 0; x < data.width; x++) {
            const bs = grid.get(x, y, z);
            if (bs !== 'minecraft:air') {
              paletteCounts.set(bs, (paletteCounts.get(bs) ?? 0) + 1);
            }
          }
        }
      }
      const sorted = [...paletteCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      for (const [block, count] of sorted) {
        const pct = ((count / info.nonAirBlocks) * 100).toFixed(1);
        console.log(`  ${chalk.gray(pct.padStart(5) + '%')} ${block} ${chalk.dim(`(${count.toLocaleString()})`)}`);
      }
    } catch (err) {
      spinner.fail('Failed to parse schematic');
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

// ─── render command ──────────────────────────────────────────────────────────

program
  .command('render <file>')
  .description('Render 2D PNGs (floor plans, cutaways, exterior)')
  .option('--floors <n>', 'Number of stories to detect', '4')
  .option('--story-height <n>', 'Blocks per story', '5')
  .option('--scale <n>', 'Floor plan scale (px/block)', '40')
  .option('--tile <n>', 'Isometric tile size', '12')
  .action(async (file: string, opts: Record<string, string>) => {
    await renderCommand(file, opts);
  });

async function renderCommand(file: string, opts: Record<string, string> = {}): Promise<void> {
  const spinner = ora('Parsing schematic...').start();
  try {
    const grid = await parseToGrid(file);
    spinner.text = 'Rendering...';

    const floors = parseInt(opts['floors'] ?? '4', 10);
    const storyH = parseInt(opts['storyHeight'] ?? opts['story-height'] ?? '5', 10);
    const scale = parseInt(opts['scale'] ?? '40', 10);
    const tile = parseInt(opts['tile'] ?? '12', 10);

    const baseName = basename(file, '.schem');

    // Floor plans
    spinner.text = 'Rendering floor plans...';
    for (let s = 0; s < floors; s++) {
      const buf = await renderFloorDetail(grid, s, { scale, storyH });
      const outFile = `${baseName}_floor_${s}.png`;
      writeFileSync(outFile, buf);
      console.log(`  ${chalk.green('+')} ${outFile}`);
    }

    // Cutaway isometrics
    spinner.text = 'Rendering cutaway views...';
    for (let s = 0; s < floors; s++) {
      const buf = await renderCutawayIso(grid, s, { tile, storyH });
      const outFile = `${baseName}_cutaway_${s}.png`;
      writeFileSync(outFile, buf);
      console.log(`  ${chalk.green('+')} ${outFile}`);
    }

    // Exterior
    spinner.text = 'Rendering exterior view...';
    const exteriorBuf = await renderExterior(grid, { tile: 8 });
    const exteriorFile = `${baseName}_exterior.png`;
    writeFileSync(exteriorFile, exteriorBuf);
    console.log(`  ${chalk.green('+')} ${exteriorFile}`);

    spinner.succeed(`Rendered ${floors * 2 + 1} images`);
  } catch (err) {
    spinner.fail('Render failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}

// ─── view command ────────────────────────────────────────────────────────────

program
  .command('view <file>')
  .description('Open 3D viewer in browser')
  .option('--port <port>', 'Server port', '3000')
  .action(async (file: string, opts: { port: string }) => {
    await viewCommand(file, opts);
  });

async function viewCommand(file: string, opts: { port?: string } = {}): Promise<void> {
  const spinner = ora('Loading schematic...').start();
  try {
    const grid = await parseToGrid(file);
    spinner.succeed(`Loaded ${grid.width}x${grid.height}x${grid.length} schematic`);

    const port = parseInt(opts.port ?? '3000', 10);
    startViewerServer(grid, { port, open: true });
    console.log(chalk.dim('  Press Ctrl+C to stop the server'));
  } catch (err) {
    spinner.fail('Failed to load schematic');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}

// ─── export command ──────────────────────────────────────────────────────────

program
  .command('export <file> [output]')
  .description('Export standalone HTML viewer')
  .action(async (file: string, output?: string) => {
    await exportCommand(file, output);
  });

async function exportCommand(file: string, output?: string): Promise<void> {
  const spinner = ora('Exporting HTML viewer...').start();
  try {
    const grid = await parseToGrid(file);
    const outFile = output ?? basename(file, '.schem') + '.html';
    await exportHTML(grid, outFile);
    spinner.succeed(`Exported to ${chalk.cyan(outFile)}`);
  } catch (err) {
    spinner.fail('Export failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}

// ─── gen command ─────────────────────────────────────────────────────────────

program
  .command('gen [type]')
  .description('Generate a structure schematic')
  .option('-f, --floors <n>', 'Number of floors', '2')
  .option('-s, --style <style>', 'Building style', 'fantasy')
  .option('-r, --rooms <rooms>', 'Comma-separated room list')
  .option('-w, --width <n>', 'Building width')
  .option('-l, --length <n>', 'Building length')
  .option('-o, --output <path>', 'Output .schem file path')
  .option('--seed <n>', 'Random seed for deterministic generation')
  .action(async (type: string | undefined, opts: Record<string, string | undefined>) => {
    const structType = (type ?? 'house') as StructureType;
    const floors = parseInt(opts['floors'] ?? '2', 10);
    const styleName = (opts['style'] ?? 'fantasy') as StyleName;
    const rooms = opts['rooms']?.split(',').map(r => r.trim()) as RoomType[] | undefined;
    const width = opts['width'] ? parseInt(opts['width'], 10) : undefined;
    const length = opts['length'] ? parseInt(opts['length'], 10) : undefined;
    const seed = opts['seed'] ? parseInt(opts['seed'], 10) : undefined;
    const output = opts['output'] ?? `${structType}_${styleName}_${floors}f.schem`;

    const spinner = ora(`Generating ${styleName} ${structType} (${floors} floors)...`).start();
    try {
      const genOpts: GenerationOptions = {
        type: structType,
        floors,
        style: styleName,
        rooms,
        width,
        length,
        seed,
      };

      const grid = generateStructure(genOpts);
      writeSchematic(grid, output);

      const nonAir = grid.countNonAir();
      spinner.succeed(`Generated ${chalk.cyan(output)}`);
      console.log(`  Dimensions: ${chalk.yellow(`${grid.width}x${grid.height}x${grid.length}`)}`);
      console.log(`  Non-air blocks: ${chalk.green(nonAir.toLocaleString())}`);
      console.log(`  Palette: ${grid.palette.size} entries`);
      console.log(`  Block entities: ${grid.blockEntities.length}`);
    } catch (err) {
      spinner.fail('Generation failed');
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

// ─── atlas command ──────────────────────────────────────────────────────────

program
  .command('atlas [output]')
  .description('Build texture atlas PNG + JSON (real textures + procedural fallback)')
  .action(async (output?: string) => {
    const spinner = ora('Building texture atlas...').start();
    try {
      const { initDefaultAtlas } = await import('./render/texture-atlas.js');
      const atlas = await initDefaultAtlas();
      const pngBuf = await atlas.toPNG();
      const jsonData = atlas.toJSON();

      const pngFile = output ?? 'atlas.png';
      const jsonFile = pngFile.replace(/\.png$/, '.json');

      writeFileSync(pngFile, pngBuf);
      writeFileSync(jsonFile, JSON.stringify(jsonData, null, 2));

      spinner.succeed(`Atlas built: ${chalk.cyan(pngFile)} (${atlas.width}x${atlas.height}, ${atlas.entries.size} textures)`);
      console.log(`  ${chalk.green('+')} ${pngFile} (${pngBuf.length.toLocaleString()} bytes)`);
      console.log(`  ${chalk.green('+')} ${jsonFile}`);
    } catch (err) {
      spinner.fail('Atlas build failed');
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

// ─── Default: serve web app ──────────────────────────────────────────────────

function printBanner(): void {
  console.log('');
  console.log(chalk.bold('  Craftmatic') + chalk.dim(' — Minecraft Schematic Toolkit'));
  console.log('');
  console.log(chalk.bold('  Commands:'));
  console.log(`    ${chalk.cyan('craftmatic')}                    Launch web app (generate, upload, view)`);
  console.log(`    ${chalk.cyan('craftmatic <file>')}             Render PNGs + open 3D viewer`);
  console.log(`    ${chalk.cyan('craftmatic info <file>')}        Print schematic metadata`);
  console.log(`    ${chalk.cyan('craftmatic render <file>')}      Render 2D PNGs`);
  console.log(`    ${chalk.cyan('craftmatic view <file>')}        Open 3D viewer in browser`);
  console.log(`    ${chalk.cyan('craftmatic export <file>')}      Export standalone HTML viewer`);
  console.log(`    ${chalk.cyan('craftmatic gen [type]')}         Generate a structure schematic`);
  console.log(`    ${chalk.cyan('craftmatic atlas [output]')}     Build texture atlas`);
  console.log('');
  console.log(chalk.dim('  Run craftmatic --help for full options'));
  console.log('');
}

async function launchWebApp(port: number, open: boolean): Promise<void> {
  // Resolve web/dist relative to this package's install location
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDistDir = resolve(__dirname, '..', 'web', 'dist');

  if (!existsSync(webDistDir)) {
    // Fallback: try from repo root (development)
    const devDir = resolve(__dirname, '..', '..', 'web', 'dist');
    if (existsSync(devDir)) {
      startWebAppServer(devDir, { port, open });
    } else {
      console.error(chalk.red('Web app not found. Run: npm run build:web'));
      process.exit(1);
    }
    return;
  }

  startWebAppServer(webDistDir, { port, open });
}

// ─── Parse and run ───────────────────────────────────────────────────────────

program.parse();
