import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../web/src/engine/zip-utils.js';

it('downloaded starter contains the tested runtime and matching browser codec', async () => {
  const root = new URL('../', import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, root), 'utf8');
  const bytes = readFileSync(new URL('web/public/downloads/HotSchem-Live-0.6.0.mcaddon', root));
  const archive = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const main = new TextDecoder().decode(await extractFile(archive, 'HotSchem_BP/scripts/main.js'));
  expect(main).toBe(read('bedrock/hotschem/HotSchem_BP/scripts/main.js'));
  expect(read('bedrock/hotschem/HotSchem_BP/scripts/live-import.js')).toBe(read('web/src/engine/hotschem/live-import.js'));
  expect(main).toContain("ev.id === 'hotschem:stream'");
});
