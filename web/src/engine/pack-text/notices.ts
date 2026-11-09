/**
 * Notices every shipped pack and listing carries (BIZ-55, X-05): the Mojang disclaimer, verbatim, and the
 * publisher + contact block the Minecraft usage guidelines require. Where they are written is X-02/X-03's job;
 * this module owns the text and the check that proves it landed.
 */
import type { ProductRecord } from '../../release/types.js';
import type { PackFile } from './lint.js';

/** The Minecraft Usage Guidelines disclaimer, verbatim. Never reword, re-case or wrap it. */
export const MOJANG_DISCLAIMER = 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.';

/** File name written at the root of both packs. */
export const DISCLAIMER_FILENAME = 'DISCLAIMER.txt';

export type Publisher = NonNullable<ProductRecord['publisher']>;

export interface DisclaimerOptions {
  /** Refuse a null publisher (release builds: the guidelines want a name and a non-chat contact, U1). */
  requirePublisher?: boolean;
}

/** The text of `DISCLAIMER.txt` and of a README's notice block: the disclaimer, then publisher and contact when known. */
export function disclaimerText(publisher: Publisher | null, opts: DisclaimerOptions = {}): string {
  if (!publisher && opts.requirePublisher) throw new Error('a release needs a publisher name and contact (U1)');
  const block = publisher ? `Publisher: ${publisher.name}\nContact: ${publisher.contactEmail}\n` : '';
  return `${MOJANG_DISCLAIMER}\n${block}`;
}

/** A `DISCLAIMER.txt` for one pack root (`root` ends with `/`, or is empty). */
export function disclaimerFile(root: string, publisher: Publisher | null, opts: DisclaimerOptions = {}): PackFile {
  return { name: `${root}${DISCLAIMER_FILENAME}`, data: new TextEncoder().encode(disclaimerText(publisher, opts)) };
}

/** Appends the disclaimer to a manifest description once; calling it again changes nothing. */
export function withDisclaimer(description: string): string {
  const trimmed = description.trim();
  return trimmed.includes(MOJANG_DISCLAIMER) ? trimmed : `${trimmed} ${MOJANG_DISCLAIMER}`.trim();
}

const decode = (d: Uint8Array | string): string => (typeof d === 'string' ? d : new TextDecoder().decode(d));

/**
 * Problems with a built pack set's notices: every `manifest.json` description must contain the disclaimer, every
 * manifest's directory must hold a `DISCLAIMER.txt` that contains it exactly, and a README must carry it. Empty
 * list means compliant.
 */
export function checkDisclaimer(files: readonly PackFile[]): string[] {
  const problems: string[] = [];
  const byName = new Map(files.map(f => [f.name, f]));
  const manifests = files.filter(f => /(?:^|\/)manifest\.json$/.test(f.name));
  if (!manifests.length) problems.push('no manifest.json found');
  for (const m of manifests) {
    let description = '';
    try { description = (JSON.parse(decode(m.data)) as { header?: { description?: string } }).header?.description ?? ''; } catch { /* reported below */ }
    if (!description.includes(MOJANG_DISCLAIMER)) problems.push(`${m.name}: header.description lacks the Mojang disclaimer`);
    const root = m.name.slice(0, m.name.length - 'manifest.json'.length);
    const d = byName.get(`${root}${DISCLAIMER_FILENAME}`);
    if (!d) problems.push(`${root}${DISCLAIMER_FILENAME}: missing`);
    else if (!decode(d.data).includes(MOJANG_DISCLAIMER)) problems.push(`${d.name}: does not contain the exact disclaimer`);
  }
  const readmes = files.filter(f => /(?:^|\/)readme[^/]*\.(?:txt|md)$/i.test(f.name));
  if (!readmes.length) problems.push('README: missing');
  for (const r of readmes) if (!decode(r.data).includes(MOJANG_DISCLAIMER)) problems.push(`${r.name}: lacks the Mojang disclaimer`);
  return problems;
}
