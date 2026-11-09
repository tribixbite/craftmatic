/**
 * Pure parts of `release.ts prepare` (D-08, BIZ-56): the gate record, the stages that wait on unmerged work, the
 * preconditions, the profile check, and the text of APPROVAL.md and the channel stubs. Nothing here reads a file,
 * runs a process or has any upload code: `scripts/release.ts` supplies facts and writes the results.
 */
import { MOJANG_DISCLAIMER } from '../engine/pack-text/notices.js';
import { assertReleasable } from './product.js';
import { compareSemVer, formatSemVer, parseSemVer, toManifestTriple } from './semver.js';
import type { ApprovalAction } from './prepare-types.js';
import type { IdentityLedgerEntry, ProductIdentity, ProductRecord, SemVer } from './types.js';

export type { ApprovalAction } from './prepare-types.js';

/**
 * `pass` and `fail` are verdicts. `skipped` = a dependency is not merged (the stage did not run); `not-run` = the
 * stage exists but could not run here (a missing EULA, an offline tool). Both are OPEN gates: never counted as passed.
 */
export type GateStatus = 'pass' | 'fail' | 'skipped' | 'not-run';

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

/** Stages named by plan D 3.3 whose dependency is not merged. Flip `landed` in the change that merges the dependency. */
export const PENDING_STAGES: ReadonlyArray<{ id: string; title: string; dependency: string; landed: boolean; reason: string }> = [
  { id: 'brick-blocks', title: 'Own brick blocks in the pack', dependency: 'M03', landed: false, reason: 'M03 (own brick blocks, collider reader) is not merged: the pack still ships the dev collider blocks, so there is nothing to gate yet.' },
  { id: 'placement', title: 'Air-only placement, prompt and undo', dependency: 'M07', landed: false, reason: 'M07 (bedrock-placement-pack.ts) is not merged: the placement behaviour a release must show is not in the pack.' },
  { id: 'sim', title: 'Simulator child-play and vehicles scenarios on the rewritten pack', dependency: 'M14', landed: false, reason: 'M14 (the simulator reading the namespace from the pack) is not merged: sim.ts only recognises the craftmatic: namespace, so it cannot play a rewritten pack.' },
];

/** The gates for stages that are still waiting, each skipped with its reason. */
export function pendingGates(): Gate[] {
  return PENDING_STAGES.filter(s => !s.landed).map(s => ({ id: s.id, title: s.title, status: 'skipped' as const, detail: s.reason }));
}

/** Gates that are not a pass and not a failure: the user must close them before any outward step. */
export const openGates = (gates: readonly Gate[]): Gate[] => gates.filter(g => g.status === 'skipped' || g.status === 'not-run');

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

/** Every reason the release may not be prepared (empty = go). */
export function preconditionProblems(f: PreconditionFacts): string[] {
  const out: string[] = [];
  if (f.dirtyFiles.length > 0) out.push(`the working tree is not clean (tracked changes: ${f.dirtyFiles.join(', ')}); commit first, the release is built from a commit`);
  try { assertReleasable(f.product); } catch (e) { out.push((e as Error).message); }
  if (f.product.placeholders.length > 0) out.push(`product ${f.product.id} still has placeholders (${f.product.placeholders.join(', ')}): decide them (U1) and empty the list`);
  if (!f.product.publisher) out.push(`product ${f.product.id} has no publisher name and contact (U1); the disclaimer block needs them`);
  const last = f.ledger.filter(e => e.product === f.product.id).at(-1);
  if (last && compareSemVer(f.version, parseSemVer(last.version)) <= 0) out.push(`version ${formatSemVer(f.version)} must rise above the released ${last.version}`);
  const t = f.product.toolchain;
  if (f.bunVersion !== t.bun) out.push(`bun is ${f.bunVersion ?? 'not runnable'} but the product pins ${t.bun}`);
  if (f.lockfileSha256 !== t.lockfileSha256) out.push(`bun.lock sha256 ${f.lockfileSha256 ?? '(none)'} differs from the pinned ${t.lockfileSha256}`);
  if (t.ldrawLibrary.sha256 === null) out.push('the LDraw complete.zip sha256 is not pinned in the product (toolchain.ldrawLibrary.sha256 is null)');
  else if (f.ldrawArchiveSha256 !== t.ldrawLibrary.sha256) out.push(`LDraw ${t.ldrawLibrary.archive} sha256 ${f.ldrawArchiveSha256 ?? '(archive not found)'} differs from the pinned ${t.ldrawLibrary.sha256}`);
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
