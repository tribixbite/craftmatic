/**
 * Generate comprehensive showcase — all structure types × random styles/floors.
 * Produces 2 variations of each type with full render suite:
 * - .schem file
 * - Floor plan PNGs
 * - Cutaway isometric PNGs
 * - Exterior isometric PNG
 * - Standalone HTML 3D viewer
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || 'v3';
const outDir = path.join(__dirname, 'showcase', version);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const types = ['house', 'tower', 'castle', 'dungeon', 'ship',
               'cathedral', 'bridge', 'windmill', 'marketplace', 'village'];
const styles = ['fantasy', 'medieval', 'modern', 'gothic', 'rustic',
                'elven', 'desert', 'steampunk', 'underwater'];

// For each type, generate 2 random variations with different styles
const variations = [];
let seed = 42;
for (const type of types) {
  for (let v = 0; v < 2; v++) {
    const style = styles[(seed + v * 3) % styles.length];
    const floors = type === 'tower' ? 3 + (seed % 3) :
                   type === 'castle' ? 2 :
                   type === 'cathedral' ? 2 :
                   type === 'dungeon' ? 2 + (seed % 2) :
                   type === 'ship' ? 1 + (seed % 2) :
                   type === 'bridge' ? 1 :
                   type === 'windmill' ? 3 :
                   type === 'marketplace' ? 1 :
                   type === 'village' ? 1 :
                   1 + (seed % 4);
    variations.push({ type, style, floors, seed: seed + v * 1000 });
    seed += 7;
  }
}

console.log(`Generating ${variations.length} structures...\n`);

for (const v of variations) {
  const name = `${v.type}_${v.style}_${v.floors}f_s${v.seed}`;
  const schemFile = path.join(outDir, `${name}.schem`);
  const htmlFile = path.join(outDir, `${name}.html`);

  console.log(`--- ${name} ---`);

  try {
    // Generate schematic
    execSync(
      `node ${path.join(__dirname, 'dist/cli.js')} gen ${v.type} -f ${v.floors} -s ${v.style} --seed ${v.seed} -o "${schemFile}"`,
      { cwd: __dirname, timeout: 30000, stdio: 'pipe' }
    );
    console.log(`  Gen: OK`);

    // Render 2D PNGs
    const renderOut = execSync(
      `node ${path.join(__dirname, 'dist/cli.js')} render "${schemFile}" --floors ${v.floors} --story-height 5`,
      { cwd: outDir, timeout: 120000, stdio: 'pipe' }
    ).toString();
    const pngCount = (renderOut.match(/\+/g) || []).length;
    console.log(`  Render: ${pngCount} PNGs`);

    // Export HTML 3D viewer
    execSync(
      `node ${path.join(__dirname, 'dist/cli.js')} export "${schemFile}" "${htmlFile}"`,
      { cwd: __dirname, timeout: 60000, stdio: 'pipe' }
    );
    const htmlSize = fs.statSync(htmlFile).size;
    console.log(`  HTML: ${Math.round(htmlSize / 1024)}KB`);

    // Print info
    const info = execSync(
      `node ${path.join(__dirname, 'dist/cli.js')} info "${schemFile}"`,
      { cwd: __dirname, timeout: 30000, stdio: 'pipe' }
    ).toString();
    const dimMatch = info.match(/Dimensions:\s+(\d+\s*x\s*\d+\s*x\s*\d+)/);
    const blockMatch = info.match(/Non-air Blocks:\s+([\d,]+)/);
    const paletteMatch = info.match(/Palette Size:\s+(\d+)/);
    if (dimMatch) console.log(`  Dims: ${dimMatch[1]}`);
    if (blockMatch) console.log(`  Blocks: ${blockMatch[1]}`);
    if (paletteMatch) console.log(`  Palette: ${paletteMatch[1]} entries`);

  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    if (e.stderr) console.log(`  ${e.stderr.toString().slice(0, 200)}`);
  }
  console.log('');
}

// Summary
const schemCount = fs.readdirSync(outDir).filter(f => f.endsWith('.schem')).length;
const pngCount = fs.readdirSync(outDir).filter(f => f.endsWith('.png')).length;
const htmlCount = fs.readdirSync(outDir).filter(f => f.endsWith('.html')).length;
console.log(`\nTotal: ${schemCount} schematics, ${pngCount} PNGs, ${htmlCount} HTML viewers`);
console.log(`Output: ${outDir}`);
