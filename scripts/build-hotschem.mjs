import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './hotschem-zip.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'bedrock/hotschem');
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name, target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target, name + '/') : [[name, fs.readFileSync(target)]];
  });
}
const out = path.join(root, 'web/public/downloads/HotSchem-Live-0.6.0.mcaddon');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip(walk(source)));
console.log(`Built ${out}`);
