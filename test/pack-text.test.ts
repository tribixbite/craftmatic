import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractStringLiterals, lintPackFiles, lintText, type Exemption, type PackFile } from '../web/src/engine/pack-text/lint.js';
import {
  DISCLAIMER_FILENAME, MOJANG_DISCLAIMER, checkDisclaimer, disclaimerFile, disclaimerText, withDisclaimer,
} from '../web/src/engine/pack-text/notices.js';
import { PLAYER_TERMS, neutralise, playerStrings } from '../web/src/engine/pack-text/strings.js';

const ids = (text: string, opts?: Parameters<typeof lintText>[1]): string[] => lintText(text, opts).map(f => f.ruleId);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const file = (name: string, data: string): PackFile => ({ name, data: enc(data) });

// Verbatim copies of today's dev-pack text (playable-addon.ts :2626, :4062, :4099 as of 2026-11-09). Frozen here so
// the test keeps proving the lint catches them after X-02 replaces the source lines.
const DEV_RP_DESCRIPTION = 'Brick geometry from the LDraw parts, one flat 16x16 colour swatch per LEGO colour; printed faces are the only images.';
const DEV_WAND_LANG = 'item.craftmatic:creator=Alpine Castle Minifig Creator Wand';
const DEV_README = "Alpine Castle\n\nImport this .mcaddon, activate both packs, rejoin the world. the set's figures stay player-sized above 100% (a minifig is never a giant) and only shrink with a size below 100%.";

describe('pack-text lint', () => {
  it('pack-text-lint :: the lint flags "minifig" in a README', () => {
    const findings = lintPackFiles([file('bp/README.txt', 'Drive the car. A minifig is never a giant.')]);
    expect(findings.map(f => f.ruleId)).toContain('minifig');
    expect(findings.find(f => f.ruleId === 'minifig')?.file).toBe('bp/README.txt');
  });

  it('a set number in a pack name is flagged', () => {
    expect(ids('Hogwarts Castle 71043', { surface: 'name' })).toContain('set-number');
    expect(ids('Castle 10303-1', { surface: 'name' })).toContain('set-number');
    // A plain year in prose is not a set number.
    expect(ids('Copyright 2026 Example Ltd.')).not.toContain('set-number');
    // In the manifest of a pack, the name is judged as a name.
    const m = file('bp/manifest.json', JSON.stringify({ header: { name: 'Tower 4032', description: 'A tower.' } }));
    expect(lintPackFiles([m]).map(f => f.ruleId)).toContain('set-number');
  });

  it('flags every mark in the term list, not only LEGO', () => {
    for (const word of ['LEGO', 'lego®', 'Duplo', 'Technic', 'Bionicle', 'Ninjago', 'BrickHeadz', 'BrickLink', 'Studio']) {
      expect(ids(`Built with ${word} parts.`), word).toContain('lego-mark');
    }
    for (const word of ['minifig', 'Minifigure', 'minifigs', 'mini-figure']) expect(ids(`A ${word} here`), word).toContain('minifig');
    expect(ids('Legolas is not a brick')).not.toContain('lego-mark');
  });

  it('flags licensed themes, car brands and ride-brand names', () => {
    for (const t of ['Hogwarts', 'Harry Potter', 'Star Wars', 'X-wing', 'Marvel', 'Batman', 'Disney', 'Pixar', 'Ferrari']) {
      expect(ids(`The ${t} model`), t).toContain('licensed-theme');
    }
    for (const t of ['Space Mountain', 'Seven Dwarfs', 'Speed Racer', 'Six Flags']) expect(ids(`Ride ${t}`), t).toContain('ride-brand');
  });

  it('flags dev stamps in names and descriptions', () => {
    expect(ids('Castle — Playable (2026-11-09 abcd1234)', { surface: 'name' })).toContain('dev-stamp');
    expect(ids('Castle (unstamped)', { surface: 'name' })).toContain('dev-stamp');
    expect(ids('Castle (2026-11-09 abcd1234+dirty)', { surface: 'name' })).toContain('dev-stamp');
    expect(ids('Built from castle.ldr (1a2b3c4d5e6f) by pipeline 0123456789ab @ abcd1234.')).toContain('dev-stamp');
    expect(ids('Plain description without stamps.')).toEqual([]);
  });

  it('flags craftmatic ids everywhere but allows the word in credits', () => {
    expect(ids('Powered by craftmatic')).toContain('craftmatic');
    const f = lintPackFiles([file('bp/CREDITS.txt', 'Made with craftmatic. Parts: LDraw.')]);
    expect(f.map(x => x.ruleId)).not.toContain('craftmatic');
    const ids2 = lintPackFiles([file('bp/entities/car.json', '{"identifier":"craftmatic:car"}')], { checkIds: true });
    expect(ids2.map(x => x.ruleId)).toContain('craftmatic');
    expect(lintPackFiles([file('bp/entities/car.json', '{"identifier":"craftmatic:car"}')]).length).toBe(0);
  });

  it('keeps Minecraft out of the lead position but allows it in a secondary one', () => {
    expect(ids('Minecraft Castle', { surface: 'name' })).toContain('minecraft');
    expect(ids('Minecraft is fun. Castle pack.')).toContain('minecraft');
    expect(ids('A castle pack for Minecraft Bedrock.')).not.toContain('minecraft');
    expect(ids(MOJANG_DISCLAIMER)).toEqual([]);
  });

  it('lints .lang values, script string literals and ignores identifiers in scripts', () => {
    const lang = file('rp/texts/en_US.lang', '# comment about lego\nentity.tst:car.name=Minifig Car\npack.name=Fine');
    expect(lintPackFiles([lang]).map(f => f.ruleId)).toEqual(['minifig']);
    const script = file('bp/scripts/main.js', [
      "// a lego comment is not player text",
      "import { world } from '@minecraft/server';",
      "const T = 'tst:minifig_car';",
      "player.sendMessage('Hello minifig fans');",
      'form.title(`Pick a ${size} LEGO size`);',
    ].join('\n'));
    const f = lintPackFiles([script]);
    expect(f.map(x => x.ruleId).sort()).toEqual(['lego-mark', 'minifig']);
    expect(f.find(x => x.ruleId === 'minifig')?.line).toBe(4);
  });

  it('extractStringLiterals reads quotes, escapes and templates, skipping comments', () => {
    const src = ["const a = 'it\\'s fine'; // 'not this'", 'const b = "two"; /* "nor this" */', 'const c = `x ${y} z`;'].join('\n');
    expect(extractStringLiterals(src).map(l => l.text)).toEqual(["it's fine", 'two', 'x ${} z']);
  });

  it('exemptions are explicit: each needs a reason and removes only what it names', () => {
    const ex: Exemption = { id: 'wiki-quote', rule: 'lego-mark', pattern: /Rebrickable/, reason: 'names a data source in a quoted credit line' };
    expect(ids('Data from Rebrickable (LEGO catalogue).', { exemptions: [ex] })).toEqual([]);
    expect(ids('Data from the LEGO catalogue.', { exemptions: [ex] })).toContain('lego-mark');
    expect(() => lintText('x', { exemptions: [{ ...ex, reason: ' ' }] })).toThrow(/reason/);
    // Another rule on the same line is not exempted.
    expect(ids('Rebrickable minifig LEGO', { exemptions: [ex] })).toEqual(['minifig']);
  });

  it('the dev README / RP description / wand name text fails the lint (proves it catches today\'s text)', () => {
    expect(ids(DEV_RP_DESCRIPTION)).toContain('lego-mark');
    expect(ids(DEV_WAND_LANG, { surface: 'name' })).toEqual(expect.arrayContaining(['minifig', 'craftmatic']));
    const readme = lintPackFiles([file('bp/README.txt', DEV_README)]);
    expect(readme.map(f => f.ruleId)).toContain('minifig');
    expect(readme.every(f => f.file === 'bp/README.txt' && f.line >= 1 && f.match.length > 0)).toBe(true);
  });
});

describe('pack-text strings', () => {
  it('neutralise rewrites brand words into the player-facing vocabulary', () => {
    expect(neutralise('one swatch per LEGO colour')).toBe('one swatch per brick colour');
    expect(neutralise('a minifig is never a giant; minifigs; Minifigure')).toBe('a figure is never a giant; figures; Figure');
    expect(neutralise("the set's figures")).toBe("the model's figures");
    expect(ids(neutralise(DEV_README))).toEqual([]);
    expect(ids(neutralise(DEV_RP_DESCRIPTION))).toEqual([]);
  });

  it('every table entry and builder output passes the lint', () => {
    for (const [from, to] of Object.entries(PLAYER_TERMS)) expect(ids(to), `${from} -> ${to}`).toEqual([]);
    for (const text of Object.values(playerStrings).map(fn => fn('Alpine Castle', 'castle'))) {
      expect(ids(text, { surface: 'name' }), text).toEqual([]);
    }
    expect(playerStrings.creatorWandName('Alpine Castle')).toBe('Alpine Castle Figure Creator Wand');
  });
});

describe('pack-text disclaimer', () => {
  const PUBLISHER = { name: 'Example Studios Ltd', contactEmail: 'support@example.com' };

  it('the disclaimer is verbatim and the publisher + contact block follows it', () => {
    expect(MOJANG_DISCLAIMER).toBe('NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.');
    expect(disclaimerText(PUBLISHER)).toBe(`${MOJANG_DISCLAIMER}\nPublisher: Example Studios Ltd\nContact: support@example.com\n`);
    expect(disclaimerText(null)).toBe(`${MOJANG_DISCLAIMER}\n`);
    expect(() => disclaimerText(null, { requirePublisher: true })).toThrow(/publisher/i);
  });

  it('withDisclaimer appends once and is idempotent', () => {
    const once = withDisclaimer('Place with /function x.');
    expect(once).toBe(`Place with /function x. ${MOJANG_DISCLAIMER}`);
    expect(withDisclaimer(once)).toBe(once);
  });

  it('every profile pack carries the exact disclaimer in both manifests, DISCLAIMER.txt and README', () => {
    const manifest = (root: string, description: string): PackFile =>
      file(`${root}manifest.json`, JSON.stringify({ header: { name: 'Fixture', description } }));
    const good: PackFile[] = [
      manifest('bp/', withDisclaimer('Behaviour.')), manifest('rp/', withDisclaimer('Resources.')),
      disclaimerFile('bp/', PUBLISHER), disclaimerFile('rp/', PUBLISHER),
      file('bp/README.txt', `Fixture\n\n${disclaimerText(PUBLISHER)}`),
    ];
    expect(good[2]!.name).toBe(`bp/${DISCLAIMER_FILENAME}`);
    expect(checkDisclaimer(good)).toEqual([]);

    const noRpManifest = good.map(f => (f.name === 'rp/manifest.json' ? manifest('rp/', 'Resources.') : f));
    expect(checkDisclaimer(noRpManifest).join('\n')).toMatch(/rp\/manifest\.json/);
    expect(checkDisclaimer(good.filter(f => f.name !== 'rp/DISCLAIMER.txt')).join('\n')).toMatch(/rp\/DISCLAIMER\.txt/);
    expect(checkDisclaimer(good.filter(f => !f.name.endsWith('README.txt'))).join('\n')).toMatch(/README/);
    const altered = good.map(f => (f.name === 'bp/DISCLAIMER.txt' ? file(f.name, MOJANG_DISCLAIMER.toLowerCase()) : f));
    expect(checkDisclaimer(altered).join('\n')).toMatch(/bp\/DISCLAIMER\.txt/);
  });

  it('release/copy/common/disclaimer.md carries the exact disclaimer', () => {
    const md = readFileSync(resolve(__dirname, '../release/copy/common/disclaimer.md'), 'utf8');
    expect(md).toContain(MOJANG_DISCLAIMER);
    expect(lintPackFiles([file('disclaimer.md', md)])).toEqual([]);
  });
});
