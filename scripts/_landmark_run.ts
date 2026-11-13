/**
 * L00: run the merged brickgen pipeline (site -> massing -> features -> grammar -> bricker -> verify) over each
 * landmark's fetched OSM JSON and record the result next to it.
 *
 *   bun scripts/_landmark_run.ts <slug|all> [--target=1] [--views=se,nw,s,w]
 *
 * Per landmark, under `$CRAFTMATIC_DESIGNS/landmarks/<slug>/`: `run.json` (parts, components, unsupported, warnings,
 * massing height vs the documented real height) and `renders/<view>.png` (each under 2000 px; made by
 * `_grammar_render.ts`, which owns the isometric/elevation renderer). A landmark the pipeline refuses is recorded
 * with its error, never papered over. Clean room: OSM data and public dimensions only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import { LANDMARKS } from './_landmark_table.js';

const DESIGNS = process.env['CRAFTMATIC_DESIGNS'] ?? 'C:/git/craftmatic-designs';
const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const which = args.find(a => !a.startsWith('--')) ?? 'all';
const list = which === 'all' ? LANDMARKS : LANDMARKS.filter(l => l.slug === which);

for (const l of list) {
  const dir = path.join(DESIGNS, 'landmarks', l.slug);
  const file = path.join(dir, `${l.slug}.overpass.json`);
  if (!existsSync(file)) { console.error(`${l.slug}: no fetched JSON`); continue; }
  const siteJson = existsSync(path.join(dir, 'site.json')) ? JSON.parse(readFileSync(path.join(dir, 'site.json'), 'utf8')) as { realHeightM?: number } : {};
  const overpass = JSON.parse(readFileSync(file, 'utf8')) as { elements: Array<{ type: string; id: number; tags?: Record<string, string> }> };
  const result: Record<string, unknown> = { slug: l.slug, elements: overpass.elements.length, osm: l.osm };
  const partCount = overpass.elements.filter(e => e.tags?.['building:part'] !== undefined).length;
  result['osmBuildingParts'] = partCount;
  try {
    const buildingId = l.osm.find(id => overpass.elements.some(e => `${e.type}/${e.id}` === id && e.tags?.['building'] !== undefined && e.tags['building:part'] === undefined));
    const site = siteFromOverpass(overpass as never, { retrieved: new Date().toISOString().slice(0, 10), url: 'https://overpass-api.de/api/interpreter', ...(buildingId ? { buildingId } : {}) });
    const massed = buildMassing(site.site, { roles: site.roles, scale: { target: Number(flag('target', '1')) } });
    const tallest = Math.max(...massed.massing.volumes.map(v => v.topM));
    result['siteWarnings'] = site.warnings;
    result['massingWarnings'] = massed.warnings;
    result['volumes'] = massed.massing.volumes.length;
    result['massingTallestM'] = Math.round(tallest * 10) / 10;
    result['realHeightM'] = siteJson.realHeightM ?? null;
    const outBase = path.join(dir, 'renders', 'view');
    mkdirSync(path.dirname(outBase), { recursive: true });
    const run = spawnSync('bun', [
      'scripts/_grammar_render.ts', l.slug, outBase, `--fixture=${file}`, `--target=${flag('target', '1')}`,
      `--views=${flag('views', 'se,nw,s,w')}`, '--maxpx=900', ...(buildingId ? [`--building=${buildingId}`] : []),
    ], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20 * 60_000 });
    if (run.status !== 0) { result['renderError'] = (run.stderr || run.stdout).slice(-600); }
    else {
      const j = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as { report: Record<string, unknown>; notes: string[]; dims: unknown };
      result['verify'] = j.report; result['grammarNotes'] = j.notes; result['dims'] = j.dims;
    }
  } catch (e) { result['error'] = (e as Error).message; }
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(result, null, 1));
  console.log(l.slug, JSON.stringify({ ...result, siteWarnings: undefined, massingWarnings: undefined, grammarNotes: undefined }));
}
