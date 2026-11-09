import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkChangelog, parseChangelog, renderCurseForge, renderHtml, renderPackText } from '../web/src/release/changelog.js';
import { parseProduct } from '../web/src/release/product.js';

const ROOT = join(__dirname, '..');
const SAMPLE = `# Changelog

All notable changes to Fixture are recorded here.

## [Unreleased]

### Added
- A thing in progress.

## [1.1.0] - 2026-12-01

### Added
- Doors **swing** open.
- Sofa seat (see [the guide](https://example.test/guide)).

### Fixed
- A car no longer sinks when sized to 400 %.

## [1.0.0] - 2026-11-20

### Added
- First release.
`;

describe('release-changelog', () => {
  it('a release whose version has no curated section is refused', () => {
    const doc = parseChangelog(SAMPLE);
    expect(checkChangelog(doc, ['1.0.0', '1.1.0'])).toEqual([]);
    const problems = checkChangelog(doc, ['1.0.0', '1.1.0', '1.2.0']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('1.2.0');
  });

  it('parses sections newest first with dated entries grouped by kind', () => {
    const doc = parseChangelog(SAMPLE);
    expect(doc.releases.map(r => r.version)).toEqual(['1.1.0', '1.0.0']);
    expect(doc.releases[0]!.date).toBe('2026-12-01');
    expect(doc.releases[0]!.groups.map(g => g.kind)).toEqual(['Added', 'Fixed']);
    expect(doc.unreleased.groups[0]!.items).toEqual(['A thing in progress.']);
  });

  it('refuses a section that is empty, a bad date, a duplicate or a version that does not fall', () => {
    expect(checkChangelog(parseChangelog('## [1.0.0] - 2026-11-20\n'), ['1.0.0'])[0]).toContain('no entries');
    expect(checkChangelog(parseChangelog('## [1.0.0] - 2026-13-45\n\n### Added\n- x\n'), [])[0]).toContain('date');
    const dup = '## [1.0.0] - 2026-11-20\n### Added\n- a\n## [1.0.0] - 2026-11-19\n### Added\n- b\n';
    expect(checkChangelog(parseChangelog(dup), []).join('\n')).toContain('twice');
    const order = '## [1.0.0] - 2026-11-20\n### Added\n- a\n## [1.1.0] - 2026-12-01\n### Added\n- b\n';
    expect(checkChangelog(parseChangelog(order), []).join('\n')).toContain('newest first');
  });

  it('refuses a section whose heading is not a semantic version', () => {
    expect(() => parseChangelog('## [v1] - 2026-11-20\n')).toThrow(/semantic version/);
  });

  it('the CurseForge rendering contains no Markdown the editor rejects', () => {
    const out = renderCurseForge(parseChangelog(SAMPLE).releases[0]!);
    expect(out).not.toMatch(/[*_`#]|\]\(|^>/m);
    expect(out).toContain('- Doors swing open.');
    expect(out).toContain('- Sofa seat (see the guide).');
    expect(out).toContain('Added');
  });

  it('the in-pack text and the site HTML carry every release and escape markup', () => {
    const doc = parseChangelog(SAMPLE.replace('Doors **swing** open.', 'Doors <b>swing</b> & open.'));
    const txt = renderPackText(doc);
    expect(txt).toContain('1.1.0 (2026-12-01)');
    expect(txt).toContain('1.0.0 (2026-11-20)');
    expect(txt).not.toContain('Unreleased');
    const html = renderHtml(doc);
    expect(html).toContain('<h2>1.1.0');
    expect(html).toContain('&lt;b&gt;swing&lt;/b&gt; &amp; open.');
    expect(html).not.toContain('<b>');
    expect(html).toContain('<a href="https://example.test/guide">the guide</a>');
  });

  it('every registry version of every shipped product has a curated section', () => {
    const product = parseProduct(readFileSync(join(ROOT, 'release/products/sampler.json'), 'utf8'));
    const doc = parseChangelog(readFileSync(join(ROOT, 'release/changelogs/sampler.md'), 'utf8'));
    const versions = product.versions.map(v => `${v.version.major}.${v.version.minor}.${v.version.patch}`);
    expect(checkChangelog(doc, versions)).toEqual([]);
  });
});
