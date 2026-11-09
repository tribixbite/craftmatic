/**
 * `CREDITS.txt` for a shipped pack (BIZ-07): the LDraw CC BY notice, every part author once, and the
 * OpenStreetMap credit when a source needs it. Pure text; the writer decides where the file goes.
 *
 * It lists AUTHORS only. A part description names a LEGO product ("Brick 2 x 4"), and the credit file must stay
 * brand-neutral, so no description (and no part number) is ever printed.
 */

import { isCreditedEntry, type PartSourceEntry } from './part-source.js';

/** A data source a pack was built from; only its licence matters here. */
export interface CreditSource {
  /** Free-text licence id as recorded by the source (`ODbL-1.0`, `CC0-1.0`...). */
  licence: string;
}

/** What `renderCredits` may be asked for besides the ledger. */
export interface CreditsOptions {
  /** Data sources; an ODbL one adds the OpenStreetMap line. */
  sources?: readonly CreditSource[];
}

/** The exact OpenStreetMap attribution ODbL requires. */
export const OSM_CREDIT = '(c) OpenStreetMap contributors (ODbL)';

/** Authors named by the credited (LDraw.org) entries, each once, sorted. */
export function creditedAuthors(ledger: readonly PartSourceEntry[]): string[] {
  const authors = new Set<string>();
  for (const e of ledger) {
    const a = e.author?.trim();
    if (a && isCreditedEntry(e)) authors.add(a);
  }
  return [...authors].sort((a, b) => a.localeCompare(b));
}

/**
 * Render the credits file.
 * @param ledger entries from `getPartSourceLedger` (the parts the pack actually used)
 * @param options extra data-source credits
 */
export function renderCredits(ledger: readonly PartSourceEntry[], options: CreditsOptions = {}): string {
  const lines: string[] = [
    'Credits',
    '=======',
    '',
    'Part shapes in this pack come from the LDraw Parts Library (https://www.ldraw.org), whose files are',
    'licensed under the Creative Commons Attribution licence (CC BY 2.0 for older files, CC BY 4.0 for newer',
    'ones). The library is the work of the authors below. Changes: the shapes were converted to Minecraft',
    'Bedrock entity geometry.',
    '',
    'This pack is not endorsed by LDraw.org.',
    '',
    'LDraw part authors:',
  ];
  const authors = creditedAuthors(ledger);
  lines.push(...(authors.length ? authors.map(a => `- ${a}`) : ['(none recorded)']));
  if (options.sources?.some(s => /odbl/i.test(s.licence))) lines.push('', OSM_CREDIT);
  return lines.join('\n') + '\n';
}
