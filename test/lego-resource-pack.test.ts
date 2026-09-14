import { describe, expect, it } from 'vitest';
import {
  generateStudBlockPng,
  buildLegoResourcePack,
} from '../web/src/engine/lego-resource-pack.js';
import { listZipEntries, extractFile } from '../web/src/engine/zip-utils.js';

describe('LEGO Resource Pack Generator', () => {
  it('generates a valid 16x16 PNG with stud / seam patterns', () => {
    const topPng = generateStudBlockPng(255, 0, 0, true);
    const sidePng = generateStudBlockPng(255, 0, 0, false);

    // PNG signature
    expect(topPng[0]).toBe(137);
    expect(topPng[1]).toBe(80); // 'P'
    expect(topPng[2]).toBe(78); // 'N'
    expect(topPng[3]).toBe(71); // 'G'

    expect(sidePng[0]).toBe(137);
    expect(sidePng[1]).toBe(80);

    // Top and side should have different bytes due to stud emboss
    expect(topPng.length).toBeGreaterThan(50);
    expect(sidePng.length).toBeGreaterThan(50);
    expect(topPng).not.toEqual(sidePng);
  });

  it('compiles a complete Bedrock .mcpack with textures and manifests', async () => {
    const packBytes = await buildLegoResourcePack();
    expect(packBytes.length).toBeGreaterThan(1000);

    const ab = packBytes.buffer.slice(
      packBytes.byteOffset,
      packBytes.byteOffset + packBytes.byteLength
    ) as ArrayBuffer;

    const entries = listZipEntries(ab);
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('pack_icon.png');
    expect(entries).toContain('textures/terrain_texture.json');
    expect(entries).toContain('textures/blocks/concrete_red.png');
    expect(entries).toContain('textures/blocks/concrete_white.png');

    const manifestData = await extractFile(ab, 'manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestData));
    expect(manifest.format_version).toBe(2);
    expect(manifest.header.name).toContain('Craftmatic LEGO');
    expect(manifest.modules[0].type).toBe('resources');
  });
});
