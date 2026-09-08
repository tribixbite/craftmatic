#!/usr/bin/env node
/**
 * Generate `web/src/engine/bedrock-block-states.json` from Mojang's OWN
 * published Bedrock block metadata.
 *
 * WHY a generator and not a hand table: the Java→Bedrock quality problem is
 * entirely about ids and state names being subtly different, and a hand-typed
 * table is exactly where that goes wrong invisibly (a Bedrock block resolves to
 * air or to its default permutation and the build has holes / wrong-facing
 * stairs). Mojang publish the authoritative list — every block id, every state
 * name, every allowed value — in the `bedrock-samples` repo, so the table is
 * DERIVED and its provenance is a URL.
 *
 * Source (fetched live, pinned by `--ref`):
 *   https://raw.githubusercontent.com/Mojang/bedrock-samples/<ref>/metadata/vanilladata_modules/mojang-blocks.json
 *
 * Output is scoped to the ids OUR export can emit (mc-block-registry.json put
 * through the Java→Bedrock rename table in engine/bedrock-blocks.ts) plus air,
 * so the checked-in file stays small and reviewable instead of shipping all
 * 1,400 Bedrock blocks.
 *
 * Usage:  node scripts/gen-bedrock-blocks.mjs [--ref main] [--check]
 *         --check  fail (exit 1) instead of writing, if the output would change
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REGISTRY = join(ROOT, 'web/src/engine/mc-block-registry.json');
const OUT = join(ROOT, 'web/src/engine/bedrock-block-states.json');

const args = process.argv.slice(2);
const refIdx = args.indexOf('--ref');
// Pinned, NOT `main`. Three things must agree or Bedrock's block upgrade schema
// gets involved: the ids we emit, the `min_engine_version` we declare, and the
// `version` stamp in every palette entry.
//
// 1.21.40 is the OLDEST stable release in which every id we emit exists —
// measured, not assumed: the flattening arrived in waves and each wave moved
// some of our blocks (1.21.20 flattened `stonebrick`+`stone_brick_type` →
// `stone_bricks`, `stone_block_slab4` → `normal_stone_slab`, and the
// `dirt`/`sand`/`quartz_block` type states; 1.21.30 flattened the whole wall
// family, `cobblestone_wall`+`wall_block_type` → `mossy_stone_brick_wall` etc.,
// plus `purpur_pillar`; 1.21.40 added `mushroom_stem`). Generating from a NEWER
// ref would silently let in an id a 1.21.40 client does not have; from an OLDER
// one, 15 of our ids do not resolve at all.
const REF = refIdx >= 0 ? args[refIdx + 1] : 'v1.21.40.3';
const CHECK = args.includes('--check');

/**
 * The newest release the table is ALSO checked against, so an id Mojang removed
 * since the pinned ref fails here rather than in somebody's world.
 */
const FORWARD_REF = 'main';

const META_URL =
  `https://raw.githubusercontent.com/Mojang/bedrock-samples/${REF}/metadata/vanilladata_modules/mojang-blocks.json`;

/**
 * Java id → Bedrock id, for the ids where the two editions genuinely differ.
 *
 * Kept here (not imported from the TS module) so the generator has no build
 * step; `test/bedrock-blocks.test.ts` asserts the two copies agree, so they
 * cannot drift.
 */
const RENAME = {
  bricks: 'brick_block',
  nether_bricks: 'nether_brick',
  red_nether_bricks: 'red_nether_brick',
  end_stone_bricks: 'end_bricks',
  end_stone_brick_stairs: 'end_brick_stairs',
  prismarine_brick_stairs: 'prismarine_bricks_stairs',
  stone_slab: 'normal_stone_slab',
  // The trap: Bedrock's `stone_stairs` IS cobblestone stairs (inherited from the
  // pre-flattening numeric ids), and Bedrock's stone stairs are
  // `normal_stone_stairs`. Getting this pair backwards silently swaps two
  // materials rather than failing.
  stone_stairs: 'normal_stone_stairs',
  cobblestone_stairs: 'stone_stairs',
  jack_o_lantern: 'lit_pumpkin',
  light_gray_glazed_terracotta: 'silver_glazed_terracotta',
  magma_block: 'magma',
  rooted_dirt: 'dirt_with_roots',
  slime_block: 'slime',
  snow_block: 'snow',
  terracotta: 'hardened_clay',
};

/** Every Java id our exports may emit (same expansion as palette-lint.ts). */
function ourJavaIds() {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const ids = new Set(reg.blocks);
  for (const family of reg.colorFamilies) for (const color of reg.colors) ids.add(`${color}_${family}`);
  for (const key of ['slabs', 'stairs', 'fences', 'walls']) for (const id of reg[key]) ids.add(id);
  ids.add('terracotta');
  return ids;
}

/**
 * Bedrock's double slab is a separate BLOCK id, not a slab state — and where the
 * id puts the word "double" is not a rule: `oak_slab` → `oak_double_slab`, but
 * `waxed_cut_copper_slab` → `waxed_double_cut_copper_slab`. So try `double` at
 * every word position and let the real registry pick the one that exists.
 */
function findDoubleSlab(slabId, blockProps) {
  const words = slabId.split('_');
  if (words[words.length - 1] !== 'slab') return null;
  const stem = words.slice(0, -1);
  for (let i = stem.length; i >= 0; i--) {
    const candidate = [...stem.slice(0, i), 'double', ...stem.slice(i), 'slab'].join('_');
    if (blockProps.has(candidate)) return candidate;
  }
  return null;
}

const main = async () => {
  const res = await fetch(META_URL);
  if (!res.ok) throw new Error(`${META_URL} → HTTP ${res.status}`);
  const meta = await res.json();

  /** Bedrock id → ordered property names. */
  const blockProps = new Map();
  for (const item of meta.data_items) {
    blockProps.set(item.name.replace(/^minecraft:/, ''), (item.properties ?? []).map(p => p.name));
  }
  /** Property name → {type, values}. Mojang list the DEFAULT value first. */
  const propDefs = new Map();
  for (const p of meta.block_properties) {
    propDefs.set(p.name, { type: p.type, values: p.values.map(v => v.value) });
  }

  const wanted = new Set();
  const doubleSlabs = {};
  const missing = [];
  for (const javaId of ourJavaIds()) {
    const bedrockId = RENAME[javaId] ?? javaId;
    if (!blockProps.has(bedrockId)) { missing.push(`${javaId} → ${bedrockId}`); continue; }
    wanted.add(bedrockId);
    if (bedrockId.endsWith('_slab')) {
      const dbl = findDoubleSlab(bedrockId, blockProps);
      if (!dbl) { missing.push(`${bedrockId} (no double-slab block)`); continue; }
      doubleSlabs[bedrockId] = dbl;
      wanted.add(dbl);
    }
  }
  wanted.add('air');

  if (missing.length) {
    console.error(`FAIL: ${missing.length} id(s) have no Bedrock block:`);
    for (const m of missing) console.error('  ', m);
    process.exitCode = 1;
    return;
  }

  // Only the properties of the blocks we ship, with their allowed values, so the
  // encoder can emit a COMPLETE `states` compound (Bedrock's structure loader
  // matches a permutation, and a partial state set relies on its legacy
  // fallback path). Mojang's first listed value is the vanilla default.
  const properties = {};
  const blocks = {};
  for (const id of [...wanted].sort()) {
    const names = blockProps.get(id);
    blocks[id] = names;
    for (const n of names) {
      if (properties[n]) continue;
      const def = propDefs.get(n);
      if (!def) throw new Error(`property ${n} of ${id} has no definition in block_properties`);
      properties[n] = { type: def.type, default: def.values[0], values: def.values };
    }
  }

  // Forward check: every id and property we are about to ship must still exist in
  // the newest release, or a modern client will not resolve it.
  const fwd = await fetch(META_URL.replace(REF, FORWARD_REF));
  if (!fwd.ok) throw new Error(`forward check → HTTP ${fwd.status}`);
  const fwdMeta = await fwd.json();
  const fwdBlocks = new Set(fwdMeta.data_items.map(i => i.name.replace(/^minecraft:/, '')));
  const fwdProps = new Set(fwdMeta.block_properties.map(p => p.name));
  const gone = [
    ...Object.keys(blocks).filter(id => !fwdBlocks.has(id)).map(id => `block ${id}`),
    ...Object.keys(properties).filter(n => !fwdProps.has(n)).map(n => `property ${n}`),
  ];
  if (gone.length) {
    console.error(`FAIL: ${gone.length} entr(ies) no longer exist in ${FORWARD_REF}:`);
    for (const g of gone) console.error('  ', g);
    process.exitCode = 1;
    return;
  }

  const out = {
    _comment:
      'GENERATED — do not hand-edit. Bedrock block ids + their complete state schemas, for every id the Minecraft export can emit. Regenerate with `node scripts/gen-bedrock-blocks.mjs`.',
    _source: META_URL,
    _generatedFrom: `Mojang/bedrock-samples@${REF}`,
    _forwardCheckedAgainst: `Mojang/bedrock-samples@${FORWARD_REF}`,
    _blockCount: Object.keys(blocks).length,
    properties,
    blocks,
    doubleSlabs: Object.fromEntries(Object.entries(doubleSlabs).sort(([a], [b]) => a.localeCompare(b))),
  };
  const text = JSON.stringify(out, null, 2) + '\n';

  if (CHECK) {
    const current = readFileSync(OUT, 'utf8');
    // The source URL carries the ref, which differs run to run — compare the data.
    const strip = (s) => JSON.stringify({ ...JSON.parse(s), _source: '', _generatedFrom: '', _forwardCheckedAgainst: '' });
    if (strip(current) !== strip(text)) {
      console.error('FAIL: bedrock-block-states.json is stale — rerun without --check.');
      process.exitCode = 1;
      return;
    }
    console.log(`OK: ${out._blockCount} blocks, ${Object.keys(properties).length} properties, up to date.`);
    return;
  }

  writeFileSync(OUT, text);
  console.log(`Wrote ${OUT}: ${out._blockCount} blocks, ${Object.keys(properties).length} properties.`);
};

main().catch(err => { console.error(err); process.exitCode = 1; });
