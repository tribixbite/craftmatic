/**
 * End-to-end colour diff between two built `.mcaddon` packs.
 *
 * For every cube of every entity in a pack, this resolves the RGBA the cube
 * ACTUALLY samples — geometry -> render controller -> texture binding ->
 * decoded PNG texel, for six-face UVs and for box UV alike — and diffs the two
 * packs cube by cube, keyed by entity + bone + origin + size + rotation +
 * pivot. It is the offline gate for any change to how colour reaches the
 * geometry (it is what proved the box-UV/one-swatch-per-colour rewrite left
 * 79,392 cubes across three sets bit-identical in colour). It also reports
 * `cubesWithMultiColouredFaces`: cubes whose six faces do NOT sample one
 * colour, which a box-UV geometry could not express.
 *
 * usage: bun scripts/_entity_color_diff.ts <before.mcaddon> <after.mcaddon>
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { listZipEntries, extractFile } from '../web/src/engine/zip-utils.ts';

type Rgba = [number, number, number, number];
interface Img { w: number; h: number; rgba: Uint8Array }

function decodePng(raw: Uint8Array): Img {
  const png = new Uint8Array(raw);
  const dv = new DataView(png.buffer as ArrayBuffer, png.byteOffset, png.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  const idat: Uint8Array[] = [];
  for (let p = 8; p < png.length;) {
    const n = dv.getUint32(p);
    const type = new TextDecoder().decode(png.subarray(p + 4, p + 8));
    if (type === 'IDAT') idat.push(png.slice(p + 8, p + 8 + n));
    p += 12 + n;
  }
  const z = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of idat) { z.set(c, o); o += c.length; }
  const rows = new Uint8Array(inflateSync(z));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (rows[y * (1 + w * 4)] !== 0) throw new Error('unexpected PNG filter');
    rgba.set(rows.subarray(y * (1 + w * 4) + 1, (y + 1) * (1 + w * 4)), y * w * 4);
  }
  return { w, h, rgba };
}
const texel = (img: Img, x: number, y: number): Rgba => {
  const xi = ((Math.floor(x) % img.w) + img.w) % img.w, yi = ((Math.floor(y) % img.h) + img.h) % img.h;
  const o = (yi * img.w + xi) * 4;
  return [img.rgba[o]!, img.rgba[o + 1]!, img.rgba[o + 2]!, img.rgba[o + 3]!];
};

interface Cube { origin: number[]; size: number[]; pivot?: number[]; rotation?: number[]; uv: unknown }

/** cube key -> sampled RGBA, for every brick-compiled entity in the pack. */
async function sampleCubes(path: string): Promise<{ colors: Map<string, string>; counts: Record<string, number>; multiFace: number; cubes: number; geoms: number; textures: Set<string> }> {
  const b = readFileSync(path);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const entries = listZipEntries(buf);
  const dec = new TextDecoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pack JSON is read structurally, not typed.
  const readJson = async (name: string): Promise<any> => JSON.parse(dec.decode(await extractFile(buf, name)));
  const imgs = new Map<string, Img>();
  const image = async (rp: string, path: string): Promise<Img> => {
    const name = `${rp}${path}.png`;
    let img = imgs.get(name);
    if (!img) { img = decodePng(await extractFile(buf, name)); imgs.set(name, img); }
    return img;
  };

  const colors = new Map<string, string>();
  const counts: Record<string, number> = {};
  const textures = new Set<string>();
  let multiFace = 0, cubes = 0, geoms = 0;

  for (const geoFile of entries.filter(e => /models\/entity\/.*\.geo\.json$/.test(e))) {
    const rp = geoFile.slice(0, geoFile.indexOf('models/entity/'));
    const cid = geoFile.replace(/^.*models\/entity\//, '').replace(/\.geo\.json$/, '');
    const entityFile = `${rp}entity/${cid}.entity.json`;
    const rcFile = `${rp}render_controllers/${cid}.render_controllers.json`;
    if (!entries.includes(entityFile) || !entries.includes(rcFile)) continue;
    const desc = (await readJson(entityFile))['minecraft:client_entity'].description;
    const controllers = (await readJson(rcFile)).render_controllers as Record<string, { geometry: string; textures: string[] }>;
    // geometry identifier -> texture path
    const texOfGeometry = new Map<string, string>();
    for (const c of Object.values(controllers)) {
      const gKey = c.geometry.replace('Geometry.', ''), tKey = c.textures[0]!.replace('Texture.', '');
      texOfGeometry.set(desc.geometry[gKey], desc.textures[tKey]);
    }
    const geo = await readJson(geoFile);
    for (const mesh of geo['minecraft:geometry']) {
      geoms++;
      const tex = texOfGeometry.get(mesh.description.identifier);
      if (!tex) throw new Error(`${geoFile}: ${mesh.description.identifier} is bound to no texture`);
      textures.add(`${rp}${tex}.png`);
      const img = await image(rp, tex);
      for (const bone of mesh.bones ?? []) for (const cube of (bone.cubes ?? []) as Cube[]) {
        cubes++;
        let rgba: Rgba;
        if (Array.isArray(cube.uv)) {
          // Box UV: the cross starts here and is scaled by the cube's size.
          rgba = texel(img, (cube.uv as number[])[0]! + 0.5, (cube.uv as number[])[1]! + 0.5);
        } else {
          const faces = Object.values(cube.uv as Record<string, { uv: number[] }>).map(f => texel(img, f.uv[0]! + 0.5, f.uv[1]! + 0.5));
          if (new Set(faces.map(f => f.join(','))).size > 1) multiFace++;
          rgba = faces[0]!;
        }
        const key = `${cid}|${bone.name}|${cube.origin.join(',')}|${cube.size.join(',')}|${cube.rotation?.join(',') ?? ''}|${cube.pivot?.join(',') ?? ''}`;
        const value = rgba.join(',');
        const k = `${key}#${value}`;
        counts[k] = (counts[k] ?? 0) + 1;
        colors.set(key, value);
      }
    }
  }
  return { colors, counts, multiFace, cubes, geoms, textures };
}

const [beforePath, afterPath] = [process.argv[2]!, process.argv[3]!];
const before = await sampleCubes(beforePath);
const after = await sampleCubes(afterPath);

const keys = new Set([...before.colors.keys(), ...after.colors.keys()]);
let changed = 0, onlyBefore = 0, onlyAfter = 0;
const examples: string[] = [];
for (const k of keys) {
  const a = before.colors.get(k), b = after.colors.get(k);
  if (a === undefined) { onlyAfter++; continue; }
  if (b === undefined) { onlyBefore++; continue; }
  if (a !== b) { changed++; if (examples.length < 5) examples.push(`${k}: ${a} -> ${b}`); }
}
// Multiset check: the same cube geometry can repeat, so compare (cube, colour) counts too.
const allCountKeys = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
let countMismatch = 0;
for (const k of allCountKeys) if ((before.counts[k] ?? 0) !== (after.counts[k] ?? 0)) countMismatch++;

console.log(JSON.stringify({
  before: { cubes: before.cubes, geometries: before.geoms, distinctCubeKeys: before.colors.size, textures: before.textures.size, cubesWithMultiColouredFaces: before.multiFace },
  after: { cubes: after.cubes, geometries: after.geoms, distinctCubeKeys: after.colors.size, textures: after.textures.size, cubesWithMultiColouredFaces: after.multiFace },
  changedColour: changed, onlyInBefore: onlyBefore, onlyInAfter: onlyAfter,
  cubeColourCountMismatches: countMismatch,
  examples,
  verdict: changed === 0 && onlyBefore === 0 && onlyAfter === 0 && countMismatch === 0 ? 'IDENTICAL COLOURS' : 'DIFFERENT',
}, null, 1));
