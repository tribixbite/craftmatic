/**
 * Rewrite a dev add-on into a product namespace and folder layout (X-03, BIZ-22).
 *
 * Usage: bun scripts/_marketplace_pack.ts <dev.mcaddon> --creator=cmt --pack=<name> [--out=<file.mcaddon>]
 *          [--product=<release/products/x.json>]   (take the namespace, root stem and frozen uuids from a product record)
 *          [--json=<report.json>]
 *
 * `--creator` is the placeholder `cmt` until the user decides U1. Without `--out` the result is written next to the
 * input as `<name>-<namespace>.mcaddon`. Exits 1 when any `craftmatic` token survives (the guard of plan A 7.1).
 * Validate the result with `python -I scripts/_mcaddon_check.py --release <out>` and `bun scripts/sim.ts <out>`.
 *
 * TODO(marketplace-ldr): accept a design `.ldr` and build the dev pack first (today: build it with
 * `scripts/_playable_ref.ts`, then rewrite it here).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createZip, extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import { assertNoResidual, optionsFromIdentity, rewritePack, type PackFile, type RewriteOptions } from '../web/src/engine/marketplace/rewrite.ts';
import type { ProductRecord } from '../web/src/release/types.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const input = process.argv.slice(2).find(a => !a.startsWith('--'));
const creator = flag('creator') ?? 'cmt';
if (!input) {
  console.error('usage: bun scripts/_marketplace_pack.ts <dev.mcaddon> --creator=cmt --pack=<name> [--out=<file>] [--product=<json>] [--json=<report>]');
  process.exit(2);
}

let options: RewriteOptions;
const productPath = flag('product');
if (productPath) {
  const product = JSON.parse(readFileSync(productPath, 'utf8')) as ProductRecord;
  options = optionsFromIdentity(product.identity, creator);
} else {
  const pack = flag('pack');
  if (!pack) { console.error('--pack=<name> or --product=<json> is required'); process.exit(2); }
  options = { creator, pack };
}

const bytes = readFileSync(input);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const files: PackFile[] = [];
for (const name of listZipEntries(buffer)) {
  if (!name.endsWith('/')) files.push({ name, data: new Uint8Array(await extractFile(buffer, name)) });
}

const { files: out, report } = rewritePack(files, options);
const target = flag('out') ?? join(dirname(input), `${basename(input).replace(/\.mc(addon|pack)$/i, '')}-${report.namespace}.mcaddon`);
writeFileSync(target, await createZip(out, { alwaysDeflate: true }));
const json = flag('json');
if (json) writeFileSync(json, JSON.stringify(report, null, 2));

console.log(`namespace ${report.namespace}: ${files.length} files, ${report.renamed.length} moved, ${report.structureIds.length} structure id(s), ${report.bareWords.length} file(s) with a bare tool name replaced`);
for (const b of report.bareWords) console.log(`  bare word x${b.count} in ${b.file} (player text: X-05)`);
console.log(`wrote ${target}`);
assertNoResidual(report);
