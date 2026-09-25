/**
 * Golden-model regression for the playable Bedrock add-on: three real sets
 * through the REAL shared pipeline against the local LDraw library. Needs the
 * clego corpus, so it SKIPS elsewhere (CI has neither). Numbers are pinned
 * loosely on purpose — they guard the pipeline's shape (high-detail path used,
 * budgets respected, degradations diagnosed), not a byte hash: the library
 * snapshot differs per machine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { embeddedPartTexts, parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import { LEGO_ENTITY_QUALITY } from '../web/src/engine/ldraw-part-prototype.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const GOLDEN = [
  { file: 'C:/git/clego/lego_sets/OMR/75892-1.mpd', label: 'McLaren Senna (75892)', kind: 'car', cid: 'mclarensenna_car', stem: 'McLarenSenna' },
  { file: 'C:/git/clego/lego_sets/OMR/7140-1.mpd', label: 'X-wing Starfighter (7140)', kind: 'plane', cid: 'xwing_plane', stem: 'XWing' },
  { file: 'C:/git/clego/lego_sets/IOModel2V2/10300-1-present.ldr', label: 'Time Machine (10300)', kind: 'car', cid: 'timemachine_car', stem: 'TimeMachine' },
] as const;
const HAVE_CORPUS = existsSync(LDRAW_ROOT) && GOLDEN.every(g => existsSync(g.file));

const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const jsonOf = async (buffer: ArrayBuffer, name: string): Promise<any> => JSON.parse(new TextDecoder().decode(await extractFile(buffer, name)));

async function exportGolden(g: typeof GOLDEN[number]) {
  setLDrawRoot(LDRAW_ROOT);
  const doc = parseLDrawDocument(readFileSync(g.file, 'utf8'));
  seedDatTexts(embeddedPartTexts(doc));
  return runSchemPipeline({
    source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: 20, maxDim: 700 } },
    format: 'mcaddon', packStem: g.stem, packLabel: g.label, profile: 'default', lightFill: false, shapes: false,
    vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced',
  });
}

describe.skipIf(!HAVE_CORPUS)('playable add-on golden models', () => {
  for (const g of GOLDEN) {
    it(`${g.label}: high-detail path, budgets, diagnostics, rideable`, async () => {
      const result = await exportGolden(g);
      const buffer = ab(result.bytes!);
      const entries = listZipEntries(buffer);
      const bp = `Craftmatic_${g.stem.toLowerCase()}_BP/`, rp = `Craftmatic_${g.stem.toLowerCase()}_RP/`;
      expect(entries).toContain(`${bp}manifest.json`);
      expect(entries).toContain(`${rp}manifest.json`);
      // The vehicle first; the figures, props and second vehicles found beside it follow (see EntityExtra).
      expect(result.mcpack?.components?.[0]).toBe(`${g.label} (${g.kind})`);
      // A display stand left beside the vehicle ships as a brick-accurate shell (bedrock-building-shell.ts).
      for (const c of result.mcpack?.components?.slice(1) ?? []) expect(c).toMatch(/ \((figure|prop|car|seat|shell)\)$/);
      // The high-detail path was used: real geometry file + PBR texture sets, and no BlockGrid greedy fallback.
      expect(entries).toContain(`${rp}models/entity/${g.cid}.geo.json`);
      expect(entries.some(e => /textures\/entity\/craftmatic_swatch_\d+\.texture_set\.json$/.test(e))).toBe(true);
      // Every texture the client entity binds is actually in the pack: a
      // geometry now carries one colour and its own swatch, so a missing file
      // would repaint a whole colour of the model magenta in game.
      const clientDesc = (await jsonOf(buffer, `${rp}entity/${g.cid}.entity.json`))['minecraft:client_entity'].description;
      for (const path of Object.values(clientDesc.textures as Record<string, string>)) expect(entries).toContain(`${rp}${path}.png`);
      // One controller per geometry; the shared LOD `empty` geometry (default hull
      // LOD since 2026-09-19) is declared on the client and drawn by no controller
      // of its own, so it is the one key that has none.
      const geometryKeys = Object.keys(clientDesc.geometry as Record<string, string>).filter(k => k !== 'empty');
      expect(geometryKeys).toHaveLength(Object.keys((await jsonOf(buffer, `${rp}render_controllers/${g.cid}.render_controllers.json`)).render_controllers as Record<string, unknown>).length);
      expect((await jsonOf(buffer, `${rp}manifest.json`)).capabilities).toEqual(['pbr']);
      const diag = await jsonOf(buffer, `${bp}craftmatic-diagnostics.json`);
      const d = diag.entities[g.cid];
      expect(d).toBeDefined();
      expect(d.resolvedPartCount / d.uniquePartCount).toBeGreaterThan(0.9);
      expect(d.cubeCount).toBeLessThanOrEqual(LEGO_ENTITY_QUALITY.balanced.maxModelCubes + LEGO_ENTITY_QUALITY.balanced.maxStudCubes);
      expect(d.cubeCount).toBeGreaterThan(d.sourcePartCount); // more than one cuboid per part on average: not AABBs
      // Every unresolved part is an explicit AABB fallback and produces a warning.
      const fallbackParts = d.aabbFallbackParts.map((f: { part: string }) => f.part);
      for (const u of d.unresolvedParts) expect(fallbackParts).toContain(u);
      if (d.unresolvedParts.length) expect(result.mcpack!.warnings!.some(w => /bounding box/.test(w))).toBe(true);
      // Translucent pieces (windscreens) draw from their own colour's swatch
      // with the alpha-blended material; the opaque body does not.
      if (d.translucentCubeCount > 0) {
        expect(clientDesc.materials).toEqual({ default: 'entity', blend: 'entity_alphablend' });
        const controllers = (await jsonOf(buffer, `${rp}render_controllers/${g.cid}.render_controllers.json`)).render_controllers as Record<string, { materials: Array<Record<string, string>> }>;
        expect(Object.values(controllers).filter(c => c.materials[0]!['*'] === 'Material.blend').length).toBeGreaterThan(0);
      } else {
        expect(clientDesc.materials).toEqual({ default: 'entity' });
      }
      // Vehicle behaviour is intact.
      const behavior = (await jsonOf(buffer, `${bp}entities/${g.cid}.json`))['minecraft:entity'];
      expect(behavior.description.identifier).toBe(`craftmatic:${g.cid}`);
      // One seat, or the driver's first among the passengers' (a long car gets a passenger behind).
      const seats = behavior.components['minecraft:rideable'].seats;
      const driverSeat = Array.isArray(seats) ? seats[0] : seats;
      expect(driverSeat.position[1]).toBeGreaterThan(0);
      expect(behavior.components['minecraft:rideable'].seat_count).toBe(Array.isArray(seats) ? seats.length : 1);
      // A brick car or fixed wing is scripted (scripts/vehicles.js): zero native speed, attitude properties.
      // The time machine keeps the camel controller its DeLorean runtime drives.
      const scripted = g.cid !== undefined && !/10300|time/i.test(g.cid);
      if (scripted) {
        expect(behavior.components['minecraft:free_camera_controlled']).toBeDefined();
        expect(behavior.components['minecraft:movement'].value).toBe(0);
        expect(Object.keys(behavior.description.properties)).toContain('craftmatic:fl_pitch');
      } else {
        expect(behavior.components['minecraft:input_ground_controlled']).toBeDefined();
      }
      // Geometry is deterministic across runs.
      const again = await exportGolden(g);
      const geoA = await extractFile(buffer, `${rp}models/entity/${g.cid}.geo.json`);
      const geoB = await extractFile(ab(again.bytes!), `${rp}models/entity/${g.cid}.geo.json`);
      expect(Buffer.from(geoA).equals(Buffer.from(geoB))).toBe(true);
    }, 120_000);
  }
});
