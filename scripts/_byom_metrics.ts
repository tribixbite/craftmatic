/**
 * Metrics CLI for the mesh -> bricks route (BIZ-33, X-12).
 *
 *   bun scripts/_byom_metrics.ts <model.ldr> [--ldraw=<ldraw root>] [--out=<dir>] [--size=128]
 *
 * Builds the per-brick lattice of an LDraw model (ground truth) and the lattice of the SAME triangles merged into
 * one mesh (what an imported GLB looks like), scores the second against the first with `legolize/metrics.ts`,
 * and writes `<out>/<stem>-metrics.json` and `<out>/<stem>-contact.png` (reference | generated | difference per
 * axis view, under 2000 px). Prints the JSON. Needs the local LDraw library.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as THREE from 'three';
import sharp from 'sharp';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { __debugWorldTris, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { meshToLattice, latticeFromBricks } from '../web/src/engine/legolize/lattice.js';
import { measureLattices, contactSheet } from '../web/src/engine/legolize/metrics.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (n: string): string | undefined => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
if (!file) { console.error('usage: bun scripts/_byom_metrics.ts <model.ldr> [--ldraw=<root>] [--out=<dir>] [--size=128]'); process.exit(2); }
setLDrawRoot(flag('ldraw') ?? 'C:/git/clego/extracted/studio_release/app/ldraw');
const out = flag('out') ?? 'output/byom-metrics';
const stem = basename(file).replace(/\.[^.]+$/, '');

const bricks = parseLDraw(readFileSync(file, 'utf-8'));
const tris: Array<ReadonlyArray<readonly [number, number, number]>> = [];
for (const b of bricks) tris.push(...(await __debugWorldTris(b)));
const reference = await latticeFromBricks(bricks, { mode: 'solid' });

// One merged mesh in the lattice frame (LDraw Y is down).
const pos = new Float32Array(tris.length * 9);
tris.forEach((t, i) => t.forEach((v, j) => pos.set([v[0], -v[1], v[2]], i * 9 + j * 3)));
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
const group = new THREE.Group();
group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc91a09, side: THREE.DoubleSide })));
group.updateMatrixWorld(true);
const generated = await meshToLattice(group, { lduPerUnit: 1, mode: 'solid' });

const size = Number(flag('size') ?? 128);
const report = measureLattices(reference, generated, { size, parts: bricks.map((b) => b.part) });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${stem}-metrics.json`), JSON.stringify(report, null, 2));
const sheet = contactSheet(reference, generated, { shift: report.voxel.shift, tile: size });
await sharp(Buffer.from(sheet.rgb), { raw: { width: sheet.width, height: sheet.height, channels: 3 } }).png().toFile(join(out, `${stem}-contact.png`));
console.log(JSON.stringify(report, null, 2));
console.log(`wrote ${join(out, `${stem}-metrics.json`)} and ${stem}-contact.png (${sheet.width}x${sheet.height})`);
