/**
 * `PackProfile` (X-02, BIZ-23 / BIZ-51 / BIZ-52): the ONE option that turns the
 * dev pack `buildPlayableAddon` emits into a release / Marketplace / BYOM pack.
 *
 * Every field is optional and ABSENT means today's dev pack, byte for byte
 * (except the stamp and build instant the dev pack always carried): the dev
 * pack is what the phones have proved, so a profile may only ADD constraints.
 * Nothing here touches the clock, the disk or the network; the callers inject
 * `clock` and `deflate` so two builds of one input are byte-identical.
 *
 * Out of scope here, deliberately (owned by X-03, `TODO(pack-ids)`): the entity /
 * block namespace and the `Craftmatic_<stem>_BP/` folder names. `identity.namespace`
 * and `identity.folderStem` are carried for that rewriter and are not applied by
 * `buildPlayableAddon` itself.
 */
import type { ProductIdentity } from '../release/types.js';

/** The release texts. Absent keys fall back to the dev text (or, under `devStamp: false`, to its stamp-free form). */
export interface PackProfileTexts {
  /** Behaviour-pack header name; the resource pack is `<packName> Resources` so the two stay apart in the pack list. */
  packName: string;
  bpDescription: string;
  rpDescription: string;
  /** Replaces the whole `README.txt` in the behaviour pack. */
  readme: string;
  /** `texts/en_US.lang` overrides by key (`item.x`, `entity.x.name`): replace the generated line, or add it when absent. */
  lang: Record<string, string>;
}

/** Behaviour switches; every one defaults to the dev pack's value (all true except `explicitOnly`). */
export interface PackProfileFlags {
  /** Ship the 17 vanilla-path `textures/blocks/concrete_*.png` overrides (a Marketplace pack must not). */
  vanillaTextures: boolean;
  /** Ship `craftmatic-diagnostics.json`. */
  diagnostics: boolean;
  /** Allow head face art / printed faces. False REFUSES (throws) when any entity would carry a face atlas. */
  faceArt: boolean;
  /** Put the pipeline stamp in pack names/descriptions and the provenance file. False: stamp-free, source-free. */
  devStamp: boolean;
  /** X-17: no title / set-number heuristic (canon, time machine, Batcave, vehicle-by-title) is applied; only explicit hints decide. */
  explicitOnly: boolean;
}

export interface PackProfile {
  /** Frozen release identity: its five uuids replace the label-derived ones. The namespace must be set (a release refuses null). */
  identity?: ProductIdentity & { namespace: string };
  /** Manifest version triple (semver major.minor.patch) instead of the build-instant `packVersionAt`. */
  version?: [number, number, number];
  /** Build instant in epoch ms replacing `Date.now()` for `builtAt`, `computedAt` and the dev version. */
  clock?: number;
  texts?: Partial<PackProfileTexts>;
  flags?: Partial<PackProfileFlags>;
  /** B08's `ExportEntitlement`. Carried untouched on the profile for B08's hook; X-02 reads nothing from it. */
  entitlement?: unknown;
  /** Raw DEFLATE compressor replacing the host's `CompressionStream` (BIZ-51); a profile build also writes entries sorted. */
  deflate?: (data: Uint8Array) => Uint8Array;
}

/** The dev pack's value for every flag. */
export const DEV_PACK_FLAGS: Readonly<PackProfileFlags> = Object.freeze({
  vanillaTextures: true, diagnostics: true, faceArt: true, devStamp: true, explicitOnly: false,
});

/** `profile.flags` over the dev defaults: with no profile, exactly the dev pack. */
export function resolvePackFlags(profile: PackProfile | undefined): PackProfileFlags {
  return { ...DEV_PACK_FLAGS, ...profile?.flags };
}

/**
 * `lines` (`key=value`) with `overrides` applied: a line whose key is overridden
 * is replaced in place, an override with no line is appended in key order.
 */
export function applyLangOverrides(lines: readonly string[], overrides: Readonly<Record<string, string>> | undefined): string[] {
  if (!overrides) return [...lines];
  const pending = new Map(Object.entries(overrides));
  const out = lines.map(line => {
    const key = line.slice(0, Math.max(0, line.indexOf('=')));
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const key of [...pending.keys()].sort()) out.push(`${key}=${pending.get(key)!}`);
  return out;
}

/** What `labelHeuristicsAllowed` reads: any options object that may carry a `packProfile`. */
export interface LabelHeuristicsInput { packProfile?: PackProfile | undefined }

/**
 * Which labels may drive a title / set-number heuristic (X-17, BIZ-31).
 * Inputs with an explicit mode never do: a BYOM model's title is the creator's
 * word, and a brickgen design has no set number; both say what they are with
 * hints instead. `profile.flags.explicitOnly` is the switch both set.
 */
export function labelHeuristicsAllowed(input: LabelHeuristicsInput): boolean {
  return !resolvePackFlags(input.packProfile).explicitOnly;
}
