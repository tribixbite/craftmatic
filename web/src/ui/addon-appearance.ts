/**
 * What a built pack LOOKS LIKE in game, read back out of the pack itself.
 *
 * The walkable preview draws the collider grid and a marker per actor, which
 * answers "where can I stand and what is here" but never "does the model look
 * right". That question has been costing device rounds — a fabricated grey cart
 * shipped for two sets and was only caught by loading it on a phone. The pack
 * carries everything needed to answer it offline:
 *
 *   entity/<id>.entity.json          geometry map (mesh_N -> identifier),
 *                                    texture map (key -> swatch path),
 *                                    the render controllers to consult
 *   render_controllers/<id>.json     per controller: which geometry, which texture
 *   models/entity/<id>.geo.json      the cubes, in Bedrock model units (16 = 1 block)
 *
 * The compiler emits ONE mesh chunk per material, and its controller binds that
 * chunk to a single solid swatch, so a chunk's colour is its texture's. The
 * swatch is named for the LDraw colour it was made from
 * (`craftmatic_swatch_47`), so the colour resolves through
 * `resolveLdrawEntityMaterial` — the SAME resolver the compiler used to make
 * the swatch, which is why the preview cannot drift from the pack. No PNG
 * decoding, and it behaves identically in a test and in the browser.
 *
 * LOD: a controller's geometry array is `[Geometry.mesh_N, Geometry.empty]`
 * indexed by `query.distance_from_camera > D`, so index 0 is the near mesh.
 * The preview always takes index 0 — it is showing the close-up model, which
 * is the one in question.
 */
import { resolveLdrawEntityMaterial } from '@engine/ldraw-entity-materials.js';

/** A bone, as the geometry declares it. Pivot and rotation are in model units/degrees. */
export interface AppearanceBone {
  name: string;
  pivot: [number, number, number];
  rotation?: [number, number, number];
  parent?: string;
}

/** One cube. `rotation`/`pivot` are the per-cube turn a stud facet carries. */
export interface AppearanceCube {
  bone: string;
  origin: [number, number, number];
  size: [number, number, number];
  rotation?: [number, number, number];
  pivot?: [number, number, number];
  /**
   * Per-face UV (a face decal, `head-face.ts`): the ONE face the cube draws and
   * its texel rectangle in the geometry's texture. Every other face is not
   * drawn. Absent for an ordinary box-UV cube.
   */
  faceUv?: { face: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'; uv: [number, number]; size: [number, number] };
}

/** Every cube that shares one colour — one mesh chunk, one swatch. */
export interface AppearanceGroup {
  /** 0xRRGGBB. */
  colorHex: number;
  /** 0..1; below 1 the part is translucent in game too. */
  alpha: number;
  /** The LDraw colour id the swatch was named for, or null when unreadable. */
  ldrawColor: number | null;
  cubes: AppearanceCube[];
  /**
   * A REAL texture rather than a swatch (an entity's face atlas): its resource
   * path without extension and its size in texels, for cubes with `faceUv`.
   */
  texture?: { path: string; width: number; height: number };
}

export interface AddonAppearanceEntry {
  typeId: string;
  groups: AppearanceGroup[];
  bones: AppearanceBone[];
  cubeCount: number;
}

export interface AddonAppearance {
  /** Keyed by the FULL entity identifier (`craftmatic:b_10303_10303_shell`). */
  byType: Map<string, AddonAppearanceEntry>;
  cubeCount: number;
  /** Anything that could not be read, said rather than dropped. */
  notes: string[];
}

/** The resource-pack files the appearance needs, as text keyed by archive path. */
export type AppearanceSources = ReadonlyMap<string, string>;

/** Paths worth pulling out of the archive for `buildAddonAppearance`. */
export const APPEARANCE_FILE_PATTERN =
  /(^|\/)(entity\/[^/]+\.entity\.json|render_controllers\/[^/]+\.render_controllers\.json|models\/entity\/[^/]+\.geo\.json)$/;

/**
 * Render controllers Minecraft itself provides, which a pack references but
 * must never ship. Without this the preview reports every seat and screen as
 * "render controller controller.render.default not in the pack" — a warning
 * about the pack being CORRECT, which is worse than no warning at all because
 * it trains the reader to ignore the notes.
 *
 * `controller.render.default` draws `geometry.default` with `textures.default`,
 * so the entity's own maps give the preview everything it needs.
 */
const VANILLA_RENDER_CONTROLLERS: ReadonlySet<string> = new Set([
  'controller.render.default',
  'controller.render.armor_stand',
  'controller.render.item_default',
]);

const vec3 = (v: unknown, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] =>
  Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number')
    ? [v[0] as number, v[1] as number, v[2] as number]
    : fallback;

const optVec3 = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number')
    ? [v[0] as number, v[1] as number, v[2] as number]
    : undefined;

/** `textures/entity/craftmatic_swatch_47` -> 47. */
export function swatchColorId(texturePath: string): number | null {
  const m = /craftmatic_swatch_(\d+)\b/.exec(texturePath);
  return m ? Number(m[1]) : null;
}

/**
 * The colour and opacity the COMPILER gave this swatch, from the same resolver
 * it used — so the preview cannot drift from the pack it is describing. An
 * unreadable swatch falls back to a neutral grey rather than inventing a hue.
 */
function hexOf(id: number | null): { colorHex: number; alpha: number } {
  if (id === null) return { colorHex: 0xb0b8c4, alpha: 1 };
  const m = resolveLdrawEntityMaterial(id);
  const [r, g, b] = m.rgb;
  return { colorHex: (r << 16) | (g << 8) | b, alpha: m.alpha };
}

/**
 * The geometry a controller draws, as a key into the client entity's geometry
 * map. `Array.g[<expr>]` selects from `arrays.geometries['Array.g']`, whose
 * index 0 is the near mesh; a controller may also name `Geometry.mesh_0`
 * directly.
 */
function geometryKeyOf(controller: Record<string, unknown>): string | null {
  const direct = typeof controller.geometry === 'string' ? controller.geometry : '';
  const named = /^Geometry\.([A-Za-z0-9_]+)$/.exec(direct);
  if (named) return named[1]!;
  const arrayName = /^(Array\.[A-Za-z0-9_]+)\[/.exec(direct)?.[1];
  const arrays = (controller.arrays as { geometries?: Record<string, unknown> } | undefined)?.geometries;
  const list = arrayName && arrays ? arrays[arrayName] : undefined;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const m = typeof entry === 'string' ? /^Geometry\.([A-Za-z0-9_]+)$/.exec(entry) : null;
    if (m && m[1] !== 'empty') return m[1]!;
  }
  return null;
}

/** The first `Texture.<key>` a controller binds. */
function textureKeyOf(controller: Record<string, unknown>): string | null {
  const list = controller.textures;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const m = typeof entry === 'string' ? /^Texture\.([A-Za-z0-9_]+)$/.exec(entry) : null;
    if (m) return m[1]!;
  }
  return null;
}

interface GeometryDef { bones: AppearanceBone[]; cubes: AppearanceCube[]; textureSize: [number, number] }

const FACE_NAMES = ['north', 'south', 'east', 'west', 'up', 'down'] as const;

/** The one face a per-face-UV cube draws, or undefined for box UV (`uv: [u, v]`). */
function faceUvOf(uv: unknown): AppearanceCube['faceUv'] {
  if (!uv || typeof uv !== 'object' || Array.isArray(uv)) return undefined;
  for (const face of FACE_NAMES) {
    const f = (uv as Record<string, { uv?: unknown; uv_size?: unknown }>)[face];
    if (f && Array.isArray(f.uv) && Array.isArray(f.uv_size)) {
      return { face, uv: [Number(f.uv[0]), Number(f.uv[1])], size: [Number(f.uv_size[0]), Number(f.uv_size[1])] };
    }
  }
  return undefined;
}

/** Index every geometry in every `.geo.json`, by its identifier. */
function indexGeometries(sources: AppearanceSources, notes: string[]): Map<string, GeometryDef> {
  const out = new Map<string, GeometryDef>();
  for (const [path, text] of sources) {
    if (!/\.geo\.json$/.test(path)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { notes.push(`${path}: not valid JSON, skipped.`); continue; }
    const list = (parsed as { 'minecraft:geometry'?: unknown })['minecraft:geometry'];
    if (!Array.isArray(list)) continue;
    for (const geo of list) {
      const g = geo as { description?: { identifier?: string; texture_width?: number; texture_height?: number }; bones?: unknown };
      const identifier = g.description?.identifier;
      if (typeof identifier !== 'string' || !Array.isArray(g.bones)) continue;
      const bones: AppearanceBone[] = [];
      const cubes: AppearanceCube[] = [];
      for (const raw of g.bones) {
        const b = raw as {
          name?: string; pivot?: unknown; rotation?: unknown; parent?: string; cubes?: unknown;
        };
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) continue;
        bones.push({
          name, pivot: vec3(b.pivot),
          ...(optVec3(b.rotation) ? { rotation: optVec3(b.rotation)! } : {}),
          ...(typeof b.parent === 'string' ? { parent: b.parent } : {}),
        });
        if (!Array.isArray(b.cubes)) continue;
        for (const rawCube of b.cubes) {
          const c = rawCube as { origin?: unknown; size?: unknown; rotation?: unknown; pivot?: unknown; uv?: unknown };
          const origin = optVec3(c.origin), size = optVec3(c.size);
          if (!origin || !size) continue;
          cubes.push({
            bone: name, origin, size,
            ...(optVec3(c.rotation) ? { rotation: optVec3(c.rotation)! } : {}),
            ...(optVec3(c.pivot) ? { pivot: optVec3(c.pivot)! } : {}),
            ...(faceUvOf(c.uv) ? { faceUv: faceUvOf(c.uv)! } : {}),
          });
        }
      }
      out.set(identifier, { bones, cubes, textureSize: [Number(g.description?.texture_width ?? 16), Number(g.description?.texture_height ?? 16)] });
    }
  }
  return out;
}

/** Index every render controller in every controller file, by its name. */
function indexControllers(sources: AppearanceSources, notes: string[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const [path, text] of sources) {
    if (!/\.render_controllers\.json$/.test(path)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { notes.push(`${path}: not valid JSON, skipped.`); continue; }
    const map = (parsed as { render_controllers?: Record<string, unknown> }).render_controllers;
    if (!map || typeof map !== 'object') continue;
    for (const [name, def] of Object.entries(map)) {
      if (def && typeof def === 'object') out.set(name, def as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Read a pack's drawable appearance: per entity type, the cubes grouped by the
 * colour they are drawn in.
 *
 * Nothing here guesses. A controller with no readable geometry, a geometry the
 * files do not contain, or a texture that is not a Craftmatic swatch is
 * reported in `notes` and skipped, so a pack the preview cannot fully draw says
 * so instead of quietly drawing less than it ships.
 */
export function buildAddonAppearance(sources: AppearanceSources): AddonAppearance {
  const notes: string[] = [];
  const geometries = indexGeometries(sources, notes);
  const controllers = indexControllers(sources, notes);
  const byType = new Map<string, AddonAppearanceEntry>();
  let cubeCount = 0;

  for (const [path, text] of sources) {
    if (!/\.entity\.json$/.test(path)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { notes.push(`${path}: not valid JSON, skipped.`); continue; }
    const desc = (parsed as { 'minecraft:client_entity'?: { description?: Record<string, unknown> } })['minecraft:client_entity']?.description;
    if (!desc) continue;
    const typeId = typeof desc.identifier === 'string' ? desc.identifier : '';
    if (!typeId) continue;

    const geometryMap = (desc.geometry as Record<string, string> | undefined) ?? {};
    const textureMap = (desc.textures as Record<string, string> | undefined) ?? {};
    const controllerNames = Array.isArray(desc.render_controllers) ? desc.render_controllers : [];

    const groups: AppearanceGroup[] = [];
    const bones = new Map<string, AppearanceBone>();

    for (const entry of controllerNames) {
      // A controller may be named directly or wrapped as `{ name: condition }`.
      const name = typeof entry === 'string' ? entry : Object.keys(entry as object)[0];
      if (!name) continue;
      const controller = controllers.get(name);
      if (!controller && !VANILLA_RENDER_CONTROLLERS.has(name)) {
        notes.push(`${typeId}: render controller ${name} not in the pack.`);
        continue;
      }

      // A vanilla controller draws `geometry.default` with `textures.default`,
      // which is exactly what the entity's own maps already declare.
      const geoKey = controller ? geometryKeyOf(controller) : 'default';
      const geoId = geoKey ? geometryMap[geoKey] : undefined;
      if (!geoId) { notes.push(`${typeId}: ${name} names no geometry the entity declares.`); continue; }
      const geo = geometries.get(geoId);
      // A minifig creator's per-slot geometry is declared but only some slots
      // ship; an absent geometry is normal there, so it is a note, not a fault.
      if (!geo) { notes.push(`${typeId}: geometry ${geoId} is not in the pack.`); continue; }

      const texKey = controller ? textureKeyOf(controller) : 'default';
      const texPath = texKey ? textureMap[texKey] : undefined;
      const ldrawColor = texPath ? swatchColorId(texPath) : null;
      const { colorHex, alpha } = hexOf(ldrawColor);

      for (const bone of geo.bones) if (!bones.has(bone.name)) bones.set(bone.name, bone);
      // A face atlas is a real texture: the group keeps its path for the
      // preview to draw the decal cubes' one textured face each.
      const texture = texPath && ldrawColor === null && geo.cubes.some(c => c.faceUv)
        ? { path: texPath, width: geo.textureSize[0], height: geo.textureSize[1] }
        : undefined;
      if (geo.cubes.length) {
        groups.push({ colorHex, alpha, ldrawColor, cubes: geo.cubes, ...(texture ? { texture } : {}) });
        cubeCount += geo.cubes.length;
      }
    }

    if (groups.length) byType.set(typeId, { typeId, groups, bones: [...bones.values()], cubeCount: groups.reduce((n, g) => n + g.cubes.length, 0) });
  }

  return { byType, cubeCount, notes };
}
