/**
 * Pure parts of `release.ts prepare` (D-08, BIZ-56): the gate record, the stages that wait on unmerged work, the
 * preconditions, the profile check, and the text of APPROVAL.md and the channel stubs. Nothing here reads a file,
 * runs a process or has any upload code: `scripts/release.ts` supplies facts and writes the results.
 */
import { MOJANG_DISCLAIMER } from '../engine/pack-text/notices.js';
import { assertReleasable } from './product.js';
import { compareSemVer, formatSemVer, parseSemVer, toManifestTriple } from './semver.js';
import type { PackProfileFlags } from '../engine/pack-profile.js';
import type { ApprovalAction } from './prepare-types.js';
import type { IdentityLedgerEntry, ProductIdentity, ProductRecord, SemVer } from './types.js';

export type { ApprovalAction } from './prepare-types.js';

/**
 * `pass` and `fail` are verdicts. `skipped` = a dependency is not merged (the stage did not run); `not-run` = the
 * stage exists but could not run here (a missing EULA, an offline tool); `waived` = it failed only on problems the
 * product's data explicitly waives, each with a reason. All three are OPEN gates: never counted as passed.
 */
export type GateStatus = 'pass' | 'fail' | 'skipped' | 'not-run' | 'waived';

export interface Gate {
  id: string;
  title: string;
  status: GateStatus;
  /** What was measured, or why the gate did not run (always set for skipped / not-run / fail). */
  detail: string;
}

/** The ValidationReport written to `validation.json`. */
export interface ValidationFile {
  product: string;
  version: string;
  commit: string;
  fixture: boolean;
  gates: Gate[];
  /** Measured evidence per gate id (budget rows, API list, mct rules...). */
  evidence: Record<string, unknown>;
}

/**
 * The profile flags every release build sets (X-02, M03, M07): no vanilla-path textures, no diagnostics, no face art,
 * no stamp, explicit hints only, our own brick blocks instead of the concrete overrides, the compact collider states
 * (6,192 permutations, under the Marketplace's 10,000) and the air-only wand. One object so `prepare`, `verify` and
 * `finalize` (which all run `_make`) cannot disagree about what a release is.
 */
export const RELEASE_PROFILE_FLAGS: Readonly<PackProfileFlags> = Object.freeze({
  vanillaTextures: false, diagnostics: false, faceArt: false, devStamp: false, explicitOnly: true,
  brickBlocks: true, compactColliderStates: true, marketplacePlacement: true,
});

/**
 * Stages named by plan D 3.3 whose dependency is not merged. Flip `landed` in the change that merges the dependency.
 * M03 and M07 landed (their flags are in RELEASE_PROFILE_FLAGS and checked by `brickBlockProblems` / `placementProblems`);
 * M14 did not: the sim stage stays flagged.
 */
export const PENDING_STAGES: ReadonlyArray<{ id: string; title: string; dependency: string; landed: boolean; reason: string }> = [
  { id: 'sim', title: 'Simulator child-play and vehicles scenarios on the rewritten pack', dependency: 'T02 / M14', landed: false, reason: 'M14 is merged, but the simulator cannot yet PLACE a rewritten release pack (D-08b: no Placed line); T02\'s --scenario=marketplace places profile builds, so this stage switches to it once it runs on the rewritten archive.' },
];

/** The gates for stages that are still waiting, each skipped with its reason. */
export function pendingGates(): Gate[] {
  return PENDING_STAGES.filter(s => !s.landed).map(s => ({ id: s.id, title: s.title, status: 'skipped' as const, detail: s.reason }));
}

/** Gates that are not a pass and not a failure: the user must close them before any outward step. */
export const openGates = (gates: readonly Gate[]): Gate[] => gates.filter(g => g.status === 'skipped' || g.status === 'not-run' || g.status === 'waived');

/** One waiver of `<data>/gate-waivers.json`: a problem of `gate` containing `pattern` is waived, for `reason`. */
export interface GateWaiver { gate: string; pattern: string; reason: string }

/**
 * Split a failed gate's problems into those a waiver covers and the rest. A waiver needs a non-blank reason; a
 * problem no waiver names stays a failure, so a waiver can never hide anything it did not name.
 */
export function applyWaivers(gate: string, problems: readonly string[], waivers: readonly GateWaiver[]): { uncovered: string[]; waived: Array<{ problem: string; reason: string }> } {
  for (const w of waivers) if (!w.reason.trim() || !w.pattern.trim()) throw new Error(`waiver for ${w.gate} needs a pattern and a reason`);
  const uncovered: string[] = [];
  const waived: Array<{ problem: string; reason: string }> = [];
  for (const problem of problems) {
    const hit = waivers.find(w => w.gate === gate && problem.includes(w.pattern));
    if (hit) waived.push({ problem, reason: hit.reason }); else uncovered.push(problem);
  }
  return { uncovered, waived };
}

/** Everything the preconditions read; the script gathers it, tests pass literals. */
export interface PreconditionFacts {
  product: ProductRecord;
  ledger: readonly IdentityLedgerEntry[];
  version: SemVer;
  /** Tracked files with uncommitted changes (`git status --porcelain --untracked-files=no`). */
  dirtyFiles: readonly string[];
  bunVersion: string | null;
  /** sha256 of the commit's bun.lock. */
  lockfileSha256: string | null;
  /** sha256 of the LDraw `complete.zip` on this machine, or null when it is absent. */
  ldrawArchiveSha256: string | null;
}

/** The toolchain facts a pin is compared with. */
export interface PinFacts { bunVersion: string | null; lockfileSha256: string | null; ldrawArchiveSha256: string | null }

/**
 * Every toolchain pin the machine does not meet: bun, bun.lock and the LDraw archive. Shared by `prepare` (with the
 * tree and version rules) and by `verify` / `finalize`, which rebuild an OLD commit and care about the pins only.
 */
export function pinProblems(product: ProductRecord, f: PinFacts): string[] {
  const out: string[] = [];
  const t = product.toolchain;
  if (f.bunVersion !== t.bun) out.push(`bun is ${f.bunVersion ?? 'not runnable'} but the product pins ${t.bun}`);
  if (f.lockfileSha256 !== t.lockfileSha256) out.push(`bun.lock sha256 ${f.lockfileSha256 ?? '(none)'} differs from the pinned ${t.lockfileSha256}`);
  if (t.ldrawLibrary.sha256 === null) out.push('the LDraw complete.zip sha256 is not pinned in the product (toolchain.ldrawLibrary.sha256 is null)');
  else if (f.ldrawArchiveSha256 !== t.ldrawLibrary.sha256) out.push(`LDraw ${t.ldrawLibrary.archive} sha256 ${f.ldrawArchiveSha256 ?? '(archive not found)'} differs from the pinned ${t.ldrawLibrary.sha256}`);
  return out;
}

/** Every reason the release may not be prepared (empty = go). */
export function preconditionProblems(f: PreconditionFacts): string[] {
  const out: string[] = [];
  if (f.dirtyFiles.length > 0) out.push(`the working tree is not clean (tracked changes: ${f.dirtyFiles.join(', ')}); commit first, the release is built from a commit`);
  try { assertReleasable(f.product); } catch (e) { out.push((e as Error).message); }
  if (f.product.placeholders.length > 0) out.push(`product ${f.product.id} still has placeholders (${f.product.placeholders.join(', ')}): decide them (U1) and empty the list`);
  if (!f.product.publisher) out.push(`product ${f.product.id} has no publisher name and contact (U1); the disclaimer block needs them`);
  const last = f.ledger.filter(e => e.product === f.product.id).at(-1);
  if (last && compareSemVer(f.version, parseSemVer(last.version)) <= 0) out.push(`version ${formatSemVer(f.version)} must rise above the released ${last.version}`);
  out.push(...pinProblems(f.product, { bunVersion: f.bunVersion, lockfileSha256: f.lockfileSha256, ldrawArchiveSha256: f.ldrawArchiveSha256 }));
  return out;
}

/** The version to prepare: the explicit one, else 1.0.0 for a first release, else the next patch above the ledger's last. */
export function resolveVersion(productId: string, ledger: readonly IdentityLedgerEntry[], explicit?: string): SemVer {
  if (explicit !== undefined) return parseSemVer(explicit);
  const last = ledger.filter(e => e.product === productId).at(-1);
  if (!last) return { major: 1, minor: 0, patch: 0 };
  const v = parseSemVer(last.version);
  return { ...v, patch: v.patch + 1 };
}

/** One file of a built pack set (names as archived). */
export interface RawFile { name: string; data: Uint8Array }

const decode = (d: Uint8Array): string => new TextDecoder().decode(d);

/**
 * What the X-02 profile promised, read back from the built files (before the rewrite renames folders): the registry's
 * uuids and the release version in both manifests, world-scoped resources depending on the behaviour pack, no
 * diagnostics file, no vanilla-path concrete textures, no stamp in the provenance.
 */
export function profileProblems(files: readonly RawFile[], identity: ProductIdentity, version: SemVer): string[] {
  const out: string[] = [];
  const triple = toManifestTriple(version);
  type Manifest = { header: { uuid: string; version: number[]; pack_scope?: string; min_engine_version?: number[] }; modules: Array<{ type: string; uuid: string }>; dependencies?: Array<{ uuid?: string }> };
  const parsed = files.filter(f => /(^|\/)manifest\.json$/.test(f.name)).map(f => ({ file: f.name, m: JSON.parse(decode(f.data)) as Manifest }));
  const bp = parsed.find(p => p.m.modules.some(x => x.type === 'data'));
  const rp = parsed.find(p => p.m.modules.some(x => x.type === 'resources'));
  if (!bp || !rp) return ['the pack has no behaviour/resource manifest pair'];
  if (bp.m.header.uuid !== identity.uuids.bpHeader) out.push('behaviour header uuid is not the registry uuid');
  if (rp.m.header.uuid !== identity.uuids.rpHeader) out.push('resource header uuid is not the registry uuid');
  if (!bp.m.modules.some(x => x.type === 'data' && x.uuid === identity.uuids.bpData)) out.push('behaviour data module uuid is not the registry uuid');
  if (!bp.m.modules.some(x => x.type === 'script' && x.uuid === identity.uuids.bpScript)) out.push('behaviour script module uuid is not the registry uuid');
  if (!rp.m.modules.some(x => x.uuid === identity.uuids.rpResources)) out.push('resource module uuid is not the registry uuid');
  for (const p of [bp, rp]) {
    if (p.m.header.version.join('.') !== triple.join('.')) out.push(`${p.file}: version ${p.m.header.version.join('.')} is not ${triple.join('.')}`);
    if (!p.m.header.min_engine_version) out.push(`${p.file}: no min_engine_version`);
  }
  if (rp.m.header.pack_scope !== 'world') out.push('resource pack is not pack_scope world');
  if (!rp.m.dependencies?.some(d => d.uuid === identity.uuids.bpHeader)) out.push('resource pack does not depend on the behaviour pack');
  if (files.some(f => /(^|\/)craftmatic-diagnostics\.json$/.test(f.name))) out.push('craftmatic-diagnostics.json shipped');
  if (files.some(f => /(^|\/)textures\/blocks\/concrete_[^/]*\.png$/.test(f.name))) out.push('a vanilla-path concrete texture shipped');
  const prov = files.find(f => /(^|\/)craftmatic-provenance\.json$/.test(f.name));
  if (prov && (JSON.parse(decode(prov.data)) as { pipeline?: { kind?: string } }).pipeline?.kind !== 'unstamped') out.push('provenance carries a pipeline stamp');
  return out;
}

/** Most values one collider state may have under `compactColliderStates` (two states of 12: 144 combinations a block). */
export const COMPACT_STATE_VALUES = 12;

/** Number of values a block state declares: a list, or `{values: {min, max}}`. */
function stateValueCount(state: unknown): number {
  const values = (state as { values?: unknown } | undefined)?.values ?? state;
  if (Array.isArray(values)) return values.length;
  const range = values as { min?: number; max?: number } | undefined;
  return typeof range?.min === 'number' && typeof range.max === 'number' ? range.max - range.min + 1 : 0;
}

/**
 * M03 in the finished pack: every `<ns>:brick_<colour>` and `<ns>:plate_<colour>` block is defined, and no block
 * declares a state with more than 12 values (the legacy `lo`/`hi` pair has 136, which is what put the dev pack over
 * the Marketplace's 10,000 permutations). The vanilla concrete overrides are `profileProblems`' job.
 */
export function brickBlockProblems(files: readonly RawFile[], namespace: string, colours: readonly string[]): string[] {
  const out: string[] = [];
  const blocks = files.filter(f => /^[^/]+_BP\/blocks\/.*\.json$/.test(f.name))
    .map(f => (JSON.parse(decode(f.data)) as { 'minecraft:block'?: { description?: { identifier?: string; states?: Record<string, unknown> } } })['minecraft:block']?.description);
  const ids = new Set(blocks.map(b => b?.identifier));
  for (const kind of ['brick', 'plate']) for (const c of colours) if (!ids.has(`${namespace}:${kind}_${c}`)) out.push(`own brick block ${namespace}:${kind}_${c} is not in the pack`);
  for (const b of blocks) {
    for (const [name, state] of Object.entries(b?.states ?? {})) {
      const n = stateValueCount(state);
      if (n > COMPACT_STATE_VALUES) out.push(`${b?.identifier}: state ${name} has ${n} values (compact collider states allow ${COMPACT_STATE_VALUES})`);
    }
  }
  return out;
}

/**
 * M07 in the finished pack: the placement script's CONFIG carries `"marketplace":true` (air-only wand, prompt, undo).
 * A dev wand has no such key.
 */
export function placementProblems(files: readonly RawFile[]): string[] {
  const scripts = files.filter(f => /^[^/]+_BP\/scripts\/placement[^/]*\.js$/.test(f.name));
  if (scripts.length === 0) return ['no placement script in the behaviour pack'];
  return scripts.filter(f => !/"marketplace"\s*:\s*true/.test(decode(f.data))).map(f => `${f.name} is not in marketplace mode (CONFIG has no "marketplace":true)`);
}

/** Substitute `{product}`, `{version}`, `{commit}` in an action template. */
const fill = (s: string, v: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? `{${k}}`);

/** An outward action every release lists. `approved` is always false here: only the user ever ticks one. */
export interface ApprovalEntry {
  id: string; action: string; exactCommandOrUrl: string; approver: 'user'; approved: false; evidenceAfter: string;
}

/** Every outward action as an ApprovalItem: all start unchecked and name the user as the approver. */
export function approvalItems(actions: readonly ApprovalAction[], vars: { product: string; version: string; commit: string }): ApprovalEntry[] {
  return actions.map(a => ({
    id: a.id, action: fill(a.action, vars), exactCommandOrUrl: fill(a.exactCommandOrUrl, vars),
    approver: 'user' as const, approved: false as const, evidenceAfter: fill(a.evidenceAfter, vars),
  }));
}

export interface ApprovalInput {
  product: string;
  version: string;
  commit: string;
  fixture: boolean;
  gates: readonly Gate[];
  items: readonly ApprovalEntry[];
  artifacts: ReadonlyArray<{ file: string; sha256: string; bytes: number }>;
}

/** APPROVAL.md: the gates, the open ones again, the artifacts, then every outward action, unchecked, in order. */
export function renderApproval(a: ApprovalInput): string {
  const open = openGates(a.gates);
  const lines: string[] = [`# Approval sheet: ${a.product} ${a.version}`, ''];
  if (a.fixture) lines.push('> TEST FIXTURE: built from a test data root with a stand-in namespace. NOT releasable. Do not tick anything below.', '');
  lines.push(`Commit: \`${a.commit}\``, '', 'Nothing below has been done. `release.ts prepare` contains no upload code: each item is yours to do (or an agent may do it with your approval), one at a time.', '');
  lines.push('## Gates', '');
  for (const g of a.gates) lines.push(`- ${g.status.toUpperCase().padEnd(7)} ${g.id}: ${g.detail}`);
  lines.push('');
  if (open.length) lines.push(`## Open gates (${open.length}): close these before any item below`, '', ...open.map(g => `- ${g.id} (${g.status}): ${g.detail}`), '');
  lines.push('## Artifacts', '', ...a.artifacts.map(f => `- \`${f.file}\` ${f.bytes} bytes sha256 \`${f.sha256}\``), '');
  lines.push('## Outward actions (in this order)', '');
  a.items.forEach((it, i) => {
    lines.push(`- [ ] ${i + 1}. **${it.id}**: ${it.action}`, `  - run/open: ${it.exactCommandOrUrl}`, `  - approver: ${it.approver}; record after: ${it.evidenceAfter}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** The release channels D-09 will generate bundles for. */
export const CHANNELS = ['curseforge', 'mcpedl', 'itch', 'kofi', 'patreon', 'affiliate', 'site'] as const;
export type Channel = typeof CHANNELS[number];

/** The approval ids that belong to a channel's CHECKLIST.md. */
const CHANNEL_ITEMS: Record<Channel, readonly string[]> = {
  curseforge: ['cf.create-project'], mcpedl: ['mcpedl.link'], itch: ['itch.page'], kofi: ['kofi.post'], patreon: ['patreon.post'],
  affiliate: ['affiliate.links'], site: ['r2.upload', 'worker.deploy', 'site.deploy'],
};

/**
 * A channel's stub bundle until D-09 lands: `fields.json` says so, `CHECKLIST.md` lists the channel's outward actions.
 * TODO(D-09): replace with `release/channels/*.json` driven generation.
 */
export function channelStub(channel: Channel, items: readonly ApprovalEntry[]): { 'fields.json': string; 'CHECKLIST.md': string } {
  const mine = items.filter(i => CHANNEL_ITEMS[channel].includes(i.id));
  return {
    'fields.json': `${JSON.stringify({ channel, status: 'stub', reason: 'D-09 (channel bundle generator) is not merged: no listing fields were generated' }, null, 2)}\n`,
    'CHECKLIST.md': `# ${channel} checklist (stub: fields come with D-09)\n\n${mine.map(i => `- [ ] ${i.action}\n  - ${i.exactCommandOrUrl}\n  - record: ${i.evidenceAfter}`).join('\n')}\n`,
  };
}

/** NOTICE.txt: the Mojang disclaimer verbatim, then the publisher block. */
export function renderNotice(publisher: ProductRecord['publisher']): string {
  const block = publisher ? `Publisher: ${publisher.name}\nContact: ${publisher.contactEmail}\n` : '';
  return `${MOJANG_DISCLAIMER}\n${block}`;
}
