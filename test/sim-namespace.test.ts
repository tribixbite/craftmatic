/**
 * M14 (BIZ-22): the simulator reads a pack's namespace from the pack. X-03's rewriter renames a dev pack's
 * `craftmatic:` ids to `<creator>_<pack>:`; the sim must then judge the rewritten twin exactly as it judges the
 * original (same scenarios, ticks, taps, violations), where 54 literals used to make it stop tapping a rewritten
 * pack's turnable.
 *
 * The pack is the nimbus stand-in (seeded parts, no library, runs in CI); the favourites' packs under
 * `output/x02-compare/main` are checked too where that folder exists.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNimbusPack, unzipAll } from './pack-profile-support.js';
import { rewritePack, type PackFile } from '../web/src/engine/marketplace/rewrite.js';
import { createZip } from '../web/src/engine/zip-utils.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { childPlay } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { ixKeys, nsId, packFamily } from '../web/src/sim/adapters/craftmatic/namespace.js';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { IX_KEYS } from '../web/src/engine/bedrock-interactives.js';

const rewrite = async (bytes: Uint8Array, pack = 'test'): Promise<Uint8Array> => {
  const files: PackFile[] = [...(await unzipAll(bytes))].map(([name, data]) => ({ name, data }));
  return createZip(rewritePack(files, { creator: 'cmt', pack }).files, { alwaysDeflate: true });
};

/** What a scenario run says about the pack, with the namespace taken out of the text so two namespaces compare. */
async function summary(bytes: Uint8Array, ns: string): Promise<unknown> {
  const strip = (s: string): string => s.split(`${ns}:`).join('NS:').split(`${ns}_`).join('NS_');
  const addon = await readAddon(bytes, 'pack');
  const cp = childPlay(addon, { quick: true });
  if (!cp) throw new Error('not a craftmatic pack');
  const out: unknown[] = [];
  for (const s of cp.scenarios) {
    const r = await runScenario(s, [await readAddon(bytes, 'pack')], { handlers: cp.handlers });
    out.push({
      name: r.name, status: r.status, ticks: r.ticks,
      violations: r.violations.map(v => strip(`${v.invariant}: ${v.message}`)),
      steps: r.steps.map(st => ({ label: strip(st.label), ok: st.ok })),
      notes: (r.notes ?? []).map(strip),
    });
  }
  return out;
}

describe('sim-namespace', () => {
  it('names come from the pack: the helpers swap only the prefix', () => {
    expect(nsId('cmt_test', 'ix_refused')).toBe('cmt_test:ix_refused');
    expect(packFamily('cmt_test', 'vehicle')).toBe('cmt_test_vehicle');
    expect(ixKeys('craftmatic')).toEqual(IX_KEYS);
    expect(ixKeys('cmt_test').open).toBe('cmt_test:ix_open');
  });

  it('child-play runs on a pack whose namespace is cmt_test exactly as on the original', async () => {
    const dev = await buildNimbusPack();
    const twin = await rewrite(dev);
    expect(readCraftmaticPack(await readAddon(dev, 'dev'))?.namespace).toBe('craftmatic');
    expect(readCraftmaticPack(await readAddon(twin, 'twin'))?.namespace).toBe('cmt_test');
    const a = await summary(dev, 'craftmatic');
    const b = await summary(twin, 'cmt_test');
    expect(b).toEqual(a);
  }, 240_000);

  const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
  // The batcave stand-in needs the real Studio library (the nimbus one seeds its parts): skipped where it is absent.
  it.skipIf(!existsSync(LDRAW_ROOT))('batcave: a scripted car, original and rewritten twin agree', async () => {
    setLDrawRoot(LDRAW_ROOT);
    const doc = parseLDrawDocument(readFileSync('test/fixtures/batcave-car-assembly.ldr', 'utf8'));
    const built = await runSchemPipeline({
      source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
      format: 'mcaddon', packStem: 'Batcave', packLabel: 'Batcave (76252-1)', profile: 'default', lightFill: false, shapes: false,
      vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1,
    });
    const twin = await rewrite(built.bytes!, 'batcave');
    expect(await summary(twin, 'cmt_batcave')).toEqual(await summary(built.bytes!, 'craftmatic'));
  }, 300_000);

  const X02 = 'C:/git/craftmatic/output/x02-compare/main';
  const favourites = existsSync(X02) ? readdirSync(X02).filter(f => f.endsWith('.mcaddon')).slice(0, 2) : [];
  it.skipIf(!favourites.length)('favourites\' packs: original and rewritten twin agree', async () => {
    for (const f of favourites) {
      const dev = new Uint8Array(readFileSync(`${X02}/${f}`));
      const twin = await rewrite(dev, `t${f.replace(/\D/g, '')}`);
      const ns = readCraftmaticPack(await readAddon(twin, 'twin'))!.namespace;
      expect(await summary(twin, ns), f).toEqual(await summary(dev, 'craftmatic'));
    }
  }, 600_000);
});
