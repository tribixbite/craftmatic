/**
 * Channel bundle generator (D-09 / BIZ-57, BIZ-58, BIZ-59; plan D section 4).
 *
 * ONE data-driven generator over `release/channels/<channel>.json`. A spec holds a channel's listing fields,
 * their length limits (each marked verified or unverified with its source), image roles bound to X-14's media
 * presets, drafted description copy and a checklist template. Given a prepared release it writes, per channel:
 *
 *   <out>/<channel>/fields.json       exactly the form's fields
 *   <out>/<channel>/limits.json       every limit with its verified/unverified status and source
 *   <out>/<channel>/description.md    the assembled description (donation links last)
 *   <out>/<channel>/images/           the sized images, copied from the media folder and re-measured
 *   <out>/<channel>/file/             the release file(s) and, where the channel takes one, changelog.md
 *   <out>/<channel>/CHECKLIST.md      unchecked approval items, each naming the user as approver
 *   <out>/UNVERIFIED-LIMITS.md        every unverified limit, for the top of APPROVAL.md (D-08)
 *
 * It uploads NOTHING: it reads the prepared files, writes under `outDir` and does no network I/O.
 * Copy is linted with X-05's forbidden-terms lint; the only text it lets through unresolved is a visible
 * `<placeholder>` (brand, contact, site; pending U1), which is reported.
 *
 * Node/Bun only (sharp reads the images' real sizes).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';
import { lintText, type Exemption, type Surface } from '../engine/pack-text/lint.js';
import { MOJANG_DISCLAIMER } from '../engine/pack-text/notices.js';
import { MAX_BYTES_EXCLUSIVE, MAX_SIDE_EXCLUSIVE, presetById, type MediaPreset } from './media-presets.js';

// ---------------------------------------------------------------- types

export type LimitStatus = 'verified' | 'unverified';

/** A length limit. `max` is characters for a string and items for a list; null means the number is unknown. */
export interface FieldLimit { max: number | null; status: LimitStatus; source: string }

export type FieldValue = string | string[] | boolean;

/** One form field. `lint` names the surface its text is linted as; `none` for selectors and flags. */
export interface ChannelField {
  key: string;
  label: string;
  value: FieldValue;
  lint: Surface | 'none';
  limit?: FieldLimit;
}

/** One description section. The generator keeps `donation` blocks after every `body` block and before `legal`. */
export interface DescriptionBlock { id: string; kind: 'body' | 'donation' | 'legal'; markdown: string }

/** An image role bound to a media preset (the single source of sizes). */
export interface ChannelImage {
  role: string;
  preset: string;
  /** Output file stem; numbered `-<n>` when the role takes several. */
  outName: string;
  min: number;
  max: number;
  /** Accepted file extensions in the media folder; default is the preset's still format. */
  extensions?: string[];
  /** Exact pixel size the form demands; must equal the preset's (checked at load). */
  exact?: [number, number];
  /** The image must be square and at least this many pixels on a side. */
  squareMinSide?: number;
  purpose: string;
  source: string;
  status: LimitStatus;
}

export interface ChannelFileSpec { kinds: string[]; changelog: boolean; note: string }

export interface ChecklistTemplate { id: string; action: string; exactCommandOrUrl: string; evidenceAfter: string }

export interface ChannelSpec {
  channel: string;
  title: string;
  templateVars?: string;
  fields: ChannelField[];
  description?: { limit: FieldLimit; blocks: DescriptionBlock[] };
  /** Reuse another channel's description (MCPEDL uploads through CurseForge; itch reuses the body). */
  descriptionFrom?: string;
  images: ChannelImage[];
  file: ChannelFileSpec | null;
  checklist: ChecklistTemplate[];
}

/** An outward action. Every one starts unchecked and names the person who must approve it. */
export interface ApprovalItem {
  id: string;
  action: string;
  exactCommandOrUrl: string;
  approver: 'user';
  approved: false;
  evidenceAfter: string;
}

export interface BundleFile { path: string; purpose: string; width?: number; height?: number; bytes: number }

export interface ChannelBundle {
  channel: string;
  fields: Record<string, FieldValue>;
  files: BundleFile[];
  checklist: ApprovalItem[];
}

/** The prepared release the generator reads (D-08 builds one; tests build a fixture). */
export interface PreparedRelease {
  product: string;
  version: string;
  /** Listing slug, e.g. `brick-sampler`. */
  slug: string;
  /** Player-facing publisher name; null leaves the visible `<Brand>` placeholder (U1). */
  brand: string | null;
  /** itch subdomain; null leaves `<brand>`. */
  brandSlug?: string | null;
  contactEmail?: string | null;
  /** Site base URL without a trailing slash; null leaves `https://<site>`. */
  siteBase?: string | null;
  /** Folder holding `<presetId>.<ext>` or `<presetId>-<n>.<ext>`. */
  mediaDir: string;
  /** Release artifacts (`.zip`, `.mcaddon`) by path. */
  artifacts: string[];
  /** The per-file changelog text (changelog.ts `renderCurseForge`). */
  changelogText?: string;
  /** Final copy (D-10) per channel, replacing the spec's drafted blocks. */
  descriptionOverrides?: Record<string, string>;
}

export interface UnverifiedLimit { channel: string; item: string; source: string }

export interface GenerationResult {
  bundles: ChannelBundle[];
  unverified: UnverifiedLimit[];
  /** Distinct visible `<placeholders>` still in any output (brand, contact, site, the user's account name). */
  placeholders: string[];
  warnings: string[];
}

// ---------------------------------------------------------------- links

/** Hosts that gate a download behind ads or a redirect; no listing may carry one. */
export const FORBIDDEN_LINK_HOSTS: readonly string[] = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'ow.ly', 'buff.ly',
  'adf.ly', 'linkvertise.com', 'ouo.io', 'shorte.st', 'exe.io', 'lootlabs.gg', 'loot-link.com', 'work.ink', 'boost.ink', 'bc.vc',
];

const URL_RE = /https?:\/\/[^\s)>\]"']+/gi;
const hostOf = (url: string): string => (/^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? '').toLowerCase();

/** Every ad-gated or shortener link in `text`, as the offending URLs. */
export function linkProblems(text: string): string[] {
  return (text.match(URL_RE) ?? []).filter(u => {
    const h = hostOf(u);
    return FORBIDDEN_LINK_HOSTS.some(bad => h === bad || h.endsWith(`.${bad}`));
  });
}

const DONATION_RE = /\/go\/(?:kofi|patreon)\b|ko-fi\.com|patreon\.com/i;
/** True when `url` is a tip or support link. */
export const isDonationUrl = (url: string): boolean => DONATION_RE.test(url);

/** True when no link that is not a donation link comes after the first donation link. */
export function donationLinksLast(text: string): boolean {
  const urls = text.match(URL_RE) ?? [];
  const first = urls.findIndex(isDonationUrl);
  return first < 0 || urls.slice(first).every(isDonationUrl);
}

// ---------------------------------------------------------------- spec loading

/** Validate one parsed spec; returns the problems (empty when sound). Presets are checked against X-14's table. */
export function specProblems(spec: ChannelSpec, fileStem: string): string[] {
  const out: string[] = [];
  if (spec.channel !== fileStem) out.push(`channel "${spec.channel}" does not match the file name "${fileStem}"`);
  const keys = new Set<string>();
  for (const f of spec.fields) {
    if (keys.has(f.key)) out.push(`duplicate field "${f.key}"`);
    keys.add(f.key);
    if (f.limit && f.limit.status === 'verified' && f.limit.max === null) out.push(`field "${f.key}": a verified limit needs a number`);
    if (f.limit && !f.limit.source.trim()) out.push(`field "${f.key}": a limit needs a source`);
  }
  for (const img of spec.images) {
    try {
      const p = presetById(img.preset);
      if (img.exact && (img.exact[0] !== p.width || img.exact[1] !== p.height)) {
        out.push(`image "${img.role}": exact ${img.exact.join('x')} differs from preset ${img.preset} (${p.width}x${p.height})`);
      }
    } catch (e) { out.push(`image "${img.role}": ${(e as Error).message}`); }
    if (img.min > img.max) out.push(`image "${img.role}": min above max`);
    if (!img.source.trim()) out.push(`image "${img.role}": needs a source`);
  }
  if (!spec.description && !spec.descriptionFrom) out.push('needs a description or descriptionFrom');
  const ids = new Set<string>();
  for (const c of spec.checklist) {
    if (ids.has(c.id)) out.push(`duplicate checklist id "${c.id}"`);
    ids.add(c.id);
  }
  return out;
}

/** Read every `<dir>/*.json` spec (sorted by name) and validate it; throws with every problem. */
export function loadChannelSpecs(dir: string): ChannelSpec[] {
  const specs = readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => ({
    stem: n.slice(0, -'.json'.length),
    spec: JSON.parse(readFileSync(join(dir, n), 'utf8')) as ChannelSpec,
  }));
  const problems = specs.flatMap(({ stem, spec }) => specProblems(spec, stem).map(p => `${stem}: ${p}`));
  for (const { spec } of specs) {
    if (spec.descriptionFrom && !specs.some(s => s.spec.channel === spec.descriptionFrom && s.spec.description)) {
      problems.push(`${spec.channel}: descriptionFrom "${spec.descriptionFrom}" has no description`);
    }
  }
  if (problems.length) throw new Error(`channel specs invalid:\n${problems.join('\n')}`);
  return specs.map(s => s.spec);
}

// ---------------------------------------------------------------- templating

type Vars = Record<string, string>;

function varsFor(r: PreparedRelease): Vars {
  return {
    brand: r.brand ?? '<Brand>',
    brandSlug: r.brandSlug ?? '<brand>',
    email: r.contactEmail ?? '<email>',
    siteBase: r.siteBase ?? 'https://<site>',
    version: r.version,
    slug: r.slug,
    product: r.product,
    distDir: `output/releases/${r.product}/${r.version}/dist`,
    disclaimer: MOJANG_DISCLAIMER,
  };
}

/** Fill `{name}` slots; an unknown slot is a programming error, never silently left in a listing. */
export function fillTemplate(text: string, vars: Vars): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`unknown template slot {${k}}`);
    return v;
  });
}

const fillValue = (v: FieldValue, vars: Vars): FieldValue =>
  typeof v === 'string' ? fillTemplate(v, vars) : Array.isArray(v) ? v.map(s => fillTemplate(s, vars)) : v;

const ORDER: Record<DescriptionBlock['kind'], number> = { body: 0, donation: 1, legal: 2 };

/** Assemble blocks: bodies first, then donation links, then the legal footer; spec order kept within a kind. */
export function assembleDescription(blocks: readonly DescriptionBlock[], vars: Vars): string {
  const sorted = blocks.map((b, i) => ({ b, i })).sort((x, y) => ORDER[x.b.kind] - ORDER[y.b.kind] || x.i - y.i);
  return `${sorted.map(({ b }) => fillTemplate(b.markdown, vars)).join('\n\n')}\n`;
}

// ---------------------------------------------------------------- lint and limits

/** One reasoned waiver: the platform tag a listing needs for discovery is not copy that leads with the game's name. */
const TAG_EXEMPTION: Exemption = {
  id: 'platform-tag', rule: 'minecraft', pattern: 'minecraft-bedrock',
  reason: 'a platform discovery tag, not a name or sentence; the game appears only as a descriptor',
};

function lintOrThrow(channel: string, what: string, text: string, surface: Surface): void {
  const findings = lintText(text, { surface, exemptions: [TAG_EXEMPTION] });
  if (findings.length) {
    throw new Error(`${channel} ${what} fails the forbidden-terms lint: ${findings.map(f => `${f.ruleId} "${f.match}" (line ${f.line})`).join('; ')}`);
  }
}

const sizeOf = (v: FieldValue): number => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 0);

function checkLimit(channel: string, key: string, v: FieldValue, limit: FieldLimit | undefined, warnings: string[]): void {
  if (!limit || limit.max === null) return;
  if (sizeOf(v) <= limit.max) return;
  const msg = `${channel} ${key}: ${sizeOf(v)} exceeds ${limit.max} (${limit.status}, ${limit.source})`;
  if (limit.status === 'verified') throw new Error(msg);
  warnings.push(msg);
}

// ---------------------------------------------------------------- images

const EXT_FORMAT: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' };

/** The pixel size a preset's output file must have (a turntable GIF is the preset's `gifWidth` wide, same aspect). */
export function expectedSize(p: MediaPreset): { width: number; height: number; maxBytes: number } {
  return p.kind === 'turntable'
    ? { width: p.gifWidth, height: Math.round(p.gifWidth * p.height / p.width), maxBytes: MAX_BYTES_EXCLUSIVE - 1 }
    : { width: p.width, height: p.height, maxBytes: p.maxBytes };
}

/** Media files for one role: `<base>.<ext>` or numbered `<base>-<n>.<ext>`, numbers ascending. */
function findMedia(mediaDir: string, base: string, exts: readonly string[]): string[] {
  const names = readdirSync(mediaDir);
  const hits: Array<{ name: string; n: number }> = [];
  for (const ext of exts) {
    if (names.includes(`${base}.${ext}`)) hits.push({ name: `${base}.${ext}`, n: 0 });
    for (const name of names) {
      const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.${ext}$`).exec(name);
      if (m) hits.push({ name, n: Number(m[1]) });
    }
  }
  return hits.sort((a, b) => a.n - b.n).map(h => join(mediaDir, h.name));
}

interface PlacedImage { dest: string; file: BundleFile }

async function placeImages(spec: ChannelSpec, mediaDir: string, outDir: string): Promise<PlacedImage[]> {
  const placed: PlacedImage[] = [];
  const imgDir = join(outDir, 'images');
  for (const img of spec.images) {
    const preset = presetById(img.preset);
    const exts = img.extensions ?? [preset.kind === 'still' ? preset.format : 'gif'];
    const found = findMedia(mediaDir, img.preset, exts).slice(0, img.max);
    if (found.length < img.min) {
      throw new Error(`${spec.channel}: image role "${img.role}" needs ${img.min} file(s) named ${img.preset}[-n].${exts.join('|')} in ${mediaDir}, found ${found.length}`);
    }
    const want = expectedSize(preset);
    for (let i = 0; i < found.length; i++) {
      const src = found[i]!;
      const ext = extname(src).slice(1).toLowerCase();
      const meta = await sharp(src).metadata();
      const bytes = statSync(src).size;
      const where = `${spec.channel} ${basename(src)}`;
      if (meta.format !== EXT_FORMAT[ext]) throw new Error(`${where}: format ${meta.format} does not match .${ext}`);
      if (meta.width !== want.width || meta.height !== want.height) {
        throw new Error(`${where}: ${meta.width}x${meta.height}, preset ${img.preset} needs ${want.width}x${want.height}`);
      }
      if (meta.width! >= MAX_SIDE_EXCLUSIVE || meta.height! >= MAX_SIDE_EXCLUSIVE) throw new Error(`${where}: a side is ${MAX_SIDE_EXCLUSIVE} px or more`);
      if (bytes > want.maxBytes) throw new Error(`${where}: ${bytes} bytes exceeds ${want.maxBytes}`);
      if (img.squareMinSide !== undefined && (meta.width !== meta.height || meta.width! < img.squareMinSide)) {
        throw new Error(`${where}: must be square and at least ${img.squareMinSide} px`);
      }
      const stem = found.length === 1 && img.max === 1 ? img.outName : `${img.outName}-${i + 1}`;
      const name = `${stem}.${ext}`;
      mkdirSync(imgDir, { recursive: true });
      copyFileSync(src, join(imgDir, name));
      placed.push({ dest: name, file: { path: `images/${name}`, purpose: img.purpose, width: meta.width, height: meta.height, bytes } });
    }
  }
  return placed;
}

// ---------------------------------------------------------------- rendering

/** `CHECKLIST.md` for one bundle: every item unchecked, the user as approver. */
export function renderChecklist(title: string, items: readonly ApprovalItem[]): string {
  const lines = [
    `# ${title}: awaiting approval`,
    '',
    'Nothing in this folder has been uploaded or published. Each box stays unchecked until the user has done the action.',
    '',
  ];
  for (const it of items) {
    lines.push(`- [ ] \`${it.id}\` (approver: ${it.approver}): ${it.action}`, `  - run or open: ${it.exactCommandOrUrl}`, `  - record afterwards: ${it.evidenceAfter}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The section D-08 puts at the top of `APPROVAL.md`: every limit to read off a form before approving. */
export function renderUnverifiedLimits(list: readonly UnverifiedLimit[]): string {
  const lines = ['## Unverified limits (read these off the form before approving)', ''];
  if (!list.length) lines.push('None.');
  for (const u of list) lines.push(`- [ ] ${u.channel}: ${u.item} (${u.source})`);
  return `${lines.join('\n')}\n`;
}

/** Unverified limits across the specs: fields, descriptions and image sizes. */
export function collectUnverified(specs: readonly ChannelSpec[]): UnverifiedLimit[] {
  const out: UnverifiedLimit[] = [];
  for (const s of specs) {
    for (const f of s.fields) if (f.limit?.status === 'unverified') out.push({ channel: s.channel, item: `field "${f.key}" length`, source: f.limit.source });
    if (s.description?.limit.status === 'unverified') out.push({ channel: s.channel, item: 'description length and Markdown support', source: s.description.limit.source });
    for (const i of s.images) if (i.status === 'unverified') out.push({ channel: s.channel, item: `image "${i.role}" size`, source: i.source });
  }
  return out;
}

const PLACEHOLDER_RE = /<[A-Za-z][A-Za-z0-9 _-]*>/g;

// ---------------------------------------------------------------- generator

const write = (path: string, text: string): void => writeFileSync(path, text, 'utf8');

/**
 * Write one folder per channel under `outDir` plus `UNVERIFIED-LIMITS.md`. Throws on a missing or mis-sized
 * image, a lint finding, an ad-gated or shortener link, donation links that are not last, or a verified limit
 * exceeded. Uploads nothing.
 */
export async function generateChannelBundles(release: PreparedRelease, specs: readonly ChannelSpec[], outDir: string): Promise<GenerationResult> {
  const vars = varsFor(release);
  const warnings: string[] = [];
  const bundles: ChannelBundle[] = [];
  const seen = new Set<string>();
  mkdirSync(outDir, { recursive: true });

  const descriptionOf = (spec: ChannelSpec): string => {
    const override = release.descriptionOverrides?.[spec.channel];
    if (override !== undefined) return fillTemplate(override, vars).replace(/\n*$/, '\n');
    const src = spec.description ? spec : specs.find(s => s.channel === spec.descriptionFrom);
    if (!src?.description) throw new Error(`${spec.channel}: no description source`);
    return assembleDescription(src.description.blocks, vars);
  };

  for (const spec of specs) {
    const dir = join(outDir, spec.channel);
    mkdirSync(dir, { recursive: true });
    const texts: string[] = [];

    // Fields: fill, lint, check limits.
    const fields: Record<string, FieldValue> = {};
    for (const f of spec.fields) {
      const v = fillValue(f.value, vars);
      fields[f.key] = v;
      if (f.lint !== 'none') for (const line of Array.isArray(v) ? v : [String(v)]) lintOrThrow(spec.channel, `field ${f.key}`, line, f.lint);
      checkLimit(spec.channel, f.key, v, f.limit, warnings);
      texts.push(...(Array.isArray(v) ? v : [String(v)]));
    }

    // Description: lint, links, donation order.
    const description = descriptionOf(spec);
    lintOrThrow(spec.channel, 'description', description, 'prose');
    const bad = linkProblems(`${description}\n${texts.join('\n')}`);
    if (bad.length) throw new Error(`${spec.channel}: ad-gated or shortener link(s): ${bad.join(', ')}`);
    if (!donationLinksLast(description)) throw new Error(`${spec.channel}: a non-donation link follows a donation link`);
    const descLimit = (spec.description ?? specs.find(s => s.channel === spec.descriptionFrom)?.description)?.limit;
    checkLimit(spec.channel, 'description', description, descLimit, warnings);
    texts.push(description);

    // Images and the release file.
    const placed = await placeImages(spec, release.mediaDir, dir);
    const files: BundleFile[] = placed.map(p => p.file);
    if (spec.file) {
      const picked = release.artifacts.filter(a => spec.file!.kinds.includes(extname(a).slice(1).toLowerCase()));
      if (!picked.length) throw new Error(`${spec.channel}: no artifact of kind ${spec.file.kinds.join('|')} in the prepared release`);
      mkdirSync(join(dir, 'file'), { recursive: true });
      for (const a of picked) {
        if (!existsSync(a)) throw new Error(`${spec.channel}: artifact ${a} is missing`);
        copyFileSync(a, join(dir, 'file', basename(a)));
        files.push({ path: `file/${basename(a)}`, purpose: spec.file.note, bytes: statSync(a).size });
      }
      if (spec.file.changelog) {
        if (release.changelogText === undefined) throw new Error(`${spec.channel}: the prepared release has no changelog text`);
        write(join(dir, 'changelog.md'), release.changelogText);
        files.push({ path: 'changelog.md', purpose: 'per-file changelog', bytes: Buffer.byteLength(release.changelogText) });
      }
    }

    // Checklist.
    const checklist: ApprovalItem[] = spec.checklist.map(c => ({
      id: c.id,
      action: fillTemplate(c.action, vars),
      exactCommandOrUrl: fillTemplate(c.exactCommandOrUrl, vars),
      approver: 'user',
      approved: false,
      evidenceAfter: fillTemplate(c.evidenceAfter, vars),
    }));
    texts.push(...checklist.flatMap(c => [c.action, c.exactCommandOrUrl]));

    write(join(dir, 'fields.json'), `${JSON.stringify(fields, null, 2)}\n`);
    write(join(dir, 'description.md'), description);
    write(join(dir, 'limits.json'), `${JSON.stringify([
      ...spec.fields.filter(f => f.limit).map(f => ({ scope: 'field', key: f.key, ...f.limit })),
      ...(descLimit ? [{ scope: 'description', key: 'description', ...descLimit }] : []),
      ...spec.images.map(i => ({ scope: 'image', key: i.role, status: i.status, source: i.source })),
    ], null, 2)}\n`);
    write(join(dir, 'CHECKLIST.md'), renderChecklist(spec.title, checklist));
    for (const t of texts) for (const m of t.match(PLACEHOLDER_RE) ?? []) seen.add(m);
    bundles.push({ channel: spec.channel, fields, files, checklist });
  }

  const unverified = collectUnverified(specs);
  write(join(outDir, 'UNVERIFIED-LIMITS.md'), renderUnverifiedLimits(unverified));
  return { bundles, unverified, placeholders: [...seen].sort(), warnings };
}
