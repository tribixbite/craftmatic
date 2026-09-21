/**
 * Custom minifig gate: build a playable `.mcaddon` holding ONE minifig NPC
 * assembled from chosen parts (minifig-rig.ts `minifigFromSpec`) through the
 * real add-on builder, against the local LDraw library, and print the
 * entity's diagnostics (rig bones, cube count, what was synthesised).
 *
 * Usage: bun scripts/_minifig_ref.ts [out.mcaddon] [--label=<text>]
 *          [--torso=<part>:<colour>] [--head=<part>:<colour>] [--hair=<part>:<colour>]
 *          [--legs=<colour>] [--hips=<colour>] [--arms=<colour>] [--hands=<colour>]
 *          [--held-right=<part>:<colour>] [--held-left=<part>:<colour>] [--cape=<colour>]
 *          [--spec=<file.json>]   (a MinifigSpec JSON; flags override its fields)
 *          [--creator=starter]   (include the standalone in-game creator wand)
 *
 * Example: bun scripts/_minifig_ref.ts --label=Knight --torso=973:4 --hair=3901:0 --legs=1 --held-right=3847:71 --cape=4
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { minifigFromSpec, type MinifigSpec } from '../web/src/engine/minifig-rig.ts';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.ts';
import { BlockGrid } from '../src/schem/types.ts';
import { modelExportStem } from '../web/src/engine/export-name.ts';
import { isSupportedCreatorTier, minifigCreatorLibrary } from '../web/src/engine/minifig-creator.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const creatorTier = flag('creator');
if (creatorTier !== undefined && !isSupportedCreatorTier(creatorTier)) throw new Error(`Unsupported creator tier: ${creatorTier}. Use --creator=starter.`);
const partColour = (v: string | undefined): { part: string; color: number } | undefined => {
  if (!v) return undefined;
  const [part, colour] = v.split(':');
  if (!part) return undefined;
  return { part, color: Number(colour ?? 14) };
};
const colour = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

const label = flag('label') ?? 'Custom Minifig';
const base: Partial<MinifigSpec> = flag('spec') ? JSON.parse(readFileSync(flag('spec')!, 'utf8')) as MinifigSpec : {};
const spec: MinifigSpec = {
  ...base,
  torso: partColour(flag('torso')) ?? base.torso ?? { part: '973', color: 4 },
  ...(partColour(flag('head')) ? { head: partColour(flag('head'))! } : {}),
  ...(partColour(flag('hair')) ? { hair: partColour(flag('hair'))! } : {}),
  ...(colour(flag('legs')) !== undefined ? { legs: { color: colour(flag('legs'))! } } : {}),
  ...(colour(flag('hips')) !== undefined ? { hips: { color: colour(flag('hips'))! } } : {}),
  ...(colour(flag('arms')) !== undefined ? { arms: { color: colour(flag('arms'))! } } : {}),
  ...(colour(flag('hands')) !== undefined ? { hands: { color: colour(flag('hands'))! } } : {}),
  ...(partColour(flag('held-right')) ? { heldRight: partColour(flag('held-right'))! } : {}),
  ...(partColour(flag('held-left')) ? { heldLeft: partColour(flag('held-left'))! } : {}),
  ...(colour(flag('cape')) !== undefined ? { cape: { color: colour(flag('cape'))! } } : {}),
};

const figure = minifigFromSpec(spec);
const stem = modelExportStem({ name: label });
const out = positional[0] ?? `output/bedrock-entity-qa/${stem}.mcaddon`;
mkdirSync(out.replace(/[\\/][^\\/]*$/, ''), { recursive: true });

const t0 = Date.now();
// One figure standing at the centre of an empty 3×3 footprint, facing −Z (the rig's own frame).
const pack = await buildPlayableAddon(new BlockGrid(3, 1, 3), {
  stem, label, figures: [{ bricks: figure.bricks, x: 1.5, y: 0, z: 1.5, facingLdu: [0, -1] }],
  ...(creatorTier ? { minifigCreator: minifigCreatorLibrary('starter') } : {}),
});
writeFileSync(out, pack.bytes);
console.log(JSON.stringify({
  label, out, ms: Date.now() - t0, bytes: pack.bytes.length,
  parts: figure.bricks.map(b => `${b.part}:${b.color}`),
  bones: figure.rig.bones.map(b => b.name),
  components: pack.components, warnings: pack.warnings,
  entities: Object.fromEntries(Object.entries(pack.diagnostics).map(([k, v]) => [k, { cubes: v.cubeCount, rotatedBones: v.rotatedBoneCount, minifig: v.minifig, unresolved: v.unresolvedParts, aabb: v.aabbFallbackParts }])),
}, null, 1));
