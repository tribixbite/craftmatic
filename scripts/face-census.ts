/**
 * Which face every head of a model gets in a Bedrock pack, decided by the SAME functions the entity compiler uses
 * (`texturedHeadFace` in ldraw-entity-compiler.ts): a printed LDraw head draws its own artwork, else seeded face art
 * for its print id, else a plain mini-doll head gets the default doll face, else the default minifig face.
 *
 * Audit 2026-11-15 A-10 (FIG-04): 152 of 235 favourite figures wore the default face. This census says, per head,
 * which print the source NAMES (a `3626cpb<N>` part name, or the `0 !CRAFTMATIC HEAD_PRINT` id a converter wrote),
 * whether a library prints it, and whether face art exists - so the share of real faces is measured from the
 * sources, and the heads still missing art are listed for `scripts/gen-face-art.py`.
 *
 * It counts HEAD PLACEMENTS in the source. A figure the export freezes into the building shell (audit A-13) has a
 * head here and no figure entity in the pack, so this is an upper bound on what the pack's figures show; the pack's
 * own `faceTextures` / `defaultFaces` diagnostics are the per-entity truth.
 */
import { faceArtImage, faceKey, isDollHead, rasterizeHeadFace } from '../web/src/engine/head-face.ts';
import { isHeadPart } from '../web/src/engine/ldraw-entity-compiler.ts';
import { datSubstitutionFor, getDatText } from '../web/src/engine/ldraw-geometry.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { descriptionOf, type PartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { partStem } from '../web/src/engine/part-id.ts';

/** The face a head is drawn with: the first two are its OWN face, the last two are defaults. */
export type FaceSource = 'printed' | 'art' | 'doll-default' | 'default';

export interface HeadCensusRow {
  /** The part name the source places. */
  part: string;
  /** The print the source names (`3626pb2588`, `92198pr0050`), or null for a plain head with no print identity. */
  print: string | null;
  /** The name the library actually served, when the alias ladder substituted one (`3626cpb2588` -> `3626cp0b`). */
  served: string | null;
  face: FaceSource;
  doll: boolean;
}

/** A real face: the head's own print, drawn from LDraw artwork or from face art. */
export const isRealFace = (face: FaceSource): boolean => face === 'printed' || face === 'art';

/**
 * The print a head NAMES: the converter's `HEAD_PRINT` id first, else a print suffix in its own part name
 * (`3626cpb2588`, `3626cp0b`, `92198p18`); null for a plain mould (`3626c`, `3626`, Mecabricks' undecorated heads).
 */
// TODO(face-source-transfer): 100 of the favourites' 319 heads name no print (Mecabricks' plain `3626`, 10326's
// no-print `.io`, 71043's LXF, DBIX heads with no element row). The same set's DBIX conversion often names them
// (76269's DbixConvV3 carries HEAD_PRINT ids its Mecabricks first pick lacks); matching heads across two sources by
// figure is not built.
export function namedHeadPrint(part: string, headPrint?: string): string | null {
  if (headPrint) return faceKey(headPrint);
  const key = faceKey(partStem(part));
  return /^(3626|28621|92198|92240|28649)p/.test(key) ? key : null;
}

/** One row per head placement in `bricks`, in source order. */
export async function censusHeads(
  bricks: readonly ParsedBrick[], geometry: PartGeometryProvider, textOf: (part: string) => Promise<string | null> = getDatText,
): Promise<HeadCensusRow[]> {
  const rows: HeadCensusRow[] = [];
  // Only a part whose TEXT describes a head is meshed: building every part's mesh of a 7,000-part set to find its
  // twenty heads took minutes. The mesh's own description (stub-corrected, `describedAs`) still decides below.
  const described = new Map<string, boolean>();
  const mayBeHead = async (part: string): Promise<boolean> => {
    const key = part.toLowerCase();
    let v = described.get(key);
    if (v === undefined) {
      const text = await textOf(part);
      v = isHeadPart(part, text === null ? '' : descriptionOf(text)) || isHeadPart(partStem(part), '');
      described.set(key, v);
    }
    return v;
  };
  for (const b of bricks) {
    if (!(await mayBeHead(b.part))) continue;
    const mesh = await geometry.getPartMesh(b.part);
    if (!mesh || !isHeadPart(b.part, mesh.description)) continue;
    const doll = isDollHead(b.part, mesh);
    const printed = rasterizeHeadFace(mesh) !== null;
    const art = !printed && faceArtImage(b.part, mesh, b.headPrint) !== null;
    const plainDoll = doll && mesh.triangles.length > 0 && mesh.triangles.every(t => t.color === 16);
    const face: FaceSource = printed ? 'printed' : art ? 'art' : plainDoll ? 'doll-default' : 'default';
    rows.push({ part: partStem(b.part), print: namedHeadPrint(b.part, b.headPrint), served: datSubstitutionFor(b.part) ?? null, face, doll });
  }
  return rows;
}

/** Per-model totals of a census. */
export interface HeadCensusSummary {
  heads: number;
  real: number;
  printed: number;
  art: number;
  /** Heads that name a print but get a default face: what face art could still fix. */
  namedDefault: number;
  /** Heads with no print identity in the source: no data says what face they had. */
  anonymous: number;
  /** Distinct named prints with no LDraw print and no art, for `gen-face-art.py`. */
  missingArt: string[];
}

export function summariseHeads(rows: readonly HeadCensusRow[]): HeadCensusSummary {
  const missing = new Set<string>();
  let printed = 0, art = 0, namedDefault = 0, anonymous = 0;
  for (const r of rows) {
    if (r.face === 'printed') printed++;
    else if (r.face === 'art') art++;
    else if (r.print) { namedDefault++; missing.add(r.print); }
    else anonymous++;
  }
  return { heads: rows.length, real: printed + art, printed, art, namedDefault, anonymous, missingArt: [...missing].sort() };
}
