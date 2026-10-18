import { describe, it, expect } from 'vitest';
import { buildCommand, displayCommand, getPath, itemArg, itemProblem, parseJsonLast, parseRegexLines, selectionIgnored, shellQuote, validateRequest } from './command.ts';
import { operationById } from './inventory.ts';
import type { SelectionItem } from './types.ts';

const ctx = { runDir: 'C:/git/craftmatic/output/console-runs/r1' };
const hog: SelectionItem = { id: '71043', set: '71043', indexPath: 'LDR/71043_hogwarts_castle.ldr', model: 'C:/git/clego/lego_sets/LDR/71043_hogwarts_castle.ldr', label: '71043 Hogwarts (lxf_conv)' };
const io: SelectionItem = { id: '76416', set: '76416', indexPath: 'IO/76416-1.io', model: 'C:/git/clego/lego_sets/IO/76416-1.io' };
const lxf: SelectionItem = { id: '10242', set: '10242', indexPath: 'LXF/10242.lxf', model: 'C:/git/clego/lego_sets/LXF/10242.lxf' };
const pack: SelectionItem = { id: 'x.mcaddon', pack: 'C:/git/craftmatic/output/bedrock-entity-qa/x.mcaddon' };

describe('buildCommand — per item', () => {
  it('renders eq / switch / positional options and omits unset ones', () => {
    const op = operationById('playable-pack')!;
    const c = buildCommand(op, [hog], { quality: 'high', mainOnly: true, label: 'Hogwarts Castle', lodDistance: 48, out: 'output/bedrock-entity-qa/hog.mcaddon' }, ctx);
    expect(c.argv).toEqual(['bun', 'scripts/_playable_ref.ts', hog.model, 'output/bedrock-entity-qa/hog.mcaddon', '--quality=high', '--mode=auto', '--facing=auto', '--label=Hogwarts Castle', '--camera=orbit', '--main-only', '--buildings=bricks', '--scale=auto', '--lod=hull', '--lod-distance=48']);
    expect(c.display).toBe(`bun scripts/_playable_ref.ts ${hog.model} output/bedrock-entity-qa/hog.mcaddon --quality=high --mode=auto --facing=auto "--label=Hogwarts Castle" --camera=orbit --main-only --buildings=bricks --scale=auto --lod=hull --lod-distance=48`);
    expect(c.files).toEqual([]);
  });
  it('appends the catalog revision when the script wants it', () => {
    const op = operationById('lego-perf-baseline')!;
    expect(buildCommand(op, [hog], {}, ctx).argv).toEqual(['node', 'scripts/lego-perf-baseline.mjs', '--set', '71043-1']);
    expect(itemArg(op, { id: 'x', set: '10316-2' })).toBe('10316-2');
  });
  it('substitutes {runDir} tokens and records them as evidence paths', () => {
    const op = operationById('lego-probe')!;
    const c = buildCommand(op, [hog], {}, ctx);
    expect(c.argv).toEqual(['node', 'scripts/_lego-probe.mjs', '71043', `${ctx.runDir}/probe`]);
    expect(c.runDirPaths).toEqual([`${ctx.runDir}/probe`]);
  });
  it('renders repeat options one flag per ";"-separated part, and the trailing --json literal', () => {
    const op = operationById('collider-treads')!;
    const c = buildCommand(op, [pack], { target: '3,1,2:station; 5,0,0', turns: true }, ctx);
    expect(c.argv.slice(2)).toEqual([pack.pack, '--turns', '--target=3,1,2:station', '--target=5,0,0', '--json']);
  });
  it('exports env options instead of argv, shown as a prefix', () => {
    const op = operationById('pixel-shot')!;
    const c = buildCommand(op, [], { name: 'after-import', serial: '10.0.0.216:41234' }, ctx);
    expect(c.argv).toEqual(['bash', 'scripts/_pixel_shot.sh', 'after-import']);
    expect(c.env).toEqual({ ANDROID_SERIAL: '10.0.0.216:41234' });
    expect(c.display).toBe('ANDROID_SERIAL=10.0.0.216:41234 bash scripts/_pixel_shot.sh after-import');
  });
  it('refuses to build a per-item command for several items', () => {
    expect(() => buildCommand(operationById('entity-silhouette')!, [hog, io], {}, ctx)).toThrow(/per-item/);
  });
});

describe('buildCommand — one process', () => {
  it('writes a listing file for {itemsFile} and passes its path (index paths, not absolute)', () => {
    const op = operationById('window-census')!;
    const c = buildCommand(op, [hog, io], {}, ctx);
    expect(c.argv).toEqual(['python', 'geograde/window_census.py', '--list', `${ctx.runDir}/items.txt`, '--out', `${ctx.runDir}/window-census.json`]);
    expect(c.files).toEqual([{ path: `${ctx.runDir}/items.txt`, content: 'LDR/71043_hogwarts_castle.ldr\nIO/76416-1.io\n' }]);
  });
  it('joins {items:csv} and passes {items:args}', () => {
    expect(buildCommand(operationById('missing-geometry-census')!, [hog, io], {}, ctx).argv.slice(2, 4)).toEqual(['--sets', '71043,76416']);
    expect(buildCommand(operationById('mcaddon-check')!, [pack, { ...pack, id: 'y', pack: 'C:/y.mcaddon' }], {}, ctx).argv).toEqual(['python', 'scripts/_mcaddon_check.py', pack.pack, 'C:/y.mcaddon']);
  });
  it('renders list options as separate tokens and lets --all ignore the selection', () => {
    const op = operationById('lxf-gt-eval')!;
    const c = buildCommand(op, [lxf], { variants: 'shipped xml_inv_ldr' }, ctx);
    expect(c.argv.slice(2)).toEqual(['--sets', '10242', '--variants', 'shipped', 'xml_inv_ldr', '--json', `${ctx.runDir}/lxf-gt.json`]);
    expect(selectionIgnored(op, { all: true })).toBe(true);
    expect(selectionIgnored(op, {})).toBe(false);
    expect(buildCommand(op, [], { all: true }, ctx).argv.slice(2, 4)).toEqual(['--all', '--sets']);
  });
  it('defaults the publisher to dry-run with the index untouched and a listing of the selection', () => {
    const op = operationById('sync-models-r2')!;
    const c = buildCommand(op, [hog], {}, ctx);
    expect(c.argv).toEqual(['python', 'sync_models_r2.py', '--dry-run', '--only-file', `${ctx.runDir}/items.txt`, '--no-index']);
  });
  it('substitutes {runDir} inside option values (scoreboard out-dir)', () => {
    const c = buildCommand(operationById('scoreboard')!, [], {}, ctx);
    expect(c.argv).toEqual(['python', 'geograde/scoreboard.py', '--resolve', '--top', '500', '--workers', '4', '--limit', '0', '--out-dir', `${ctx.runDir}/board`]);
    expect(c.runDirPaths).toEqual([`${ctx.runDir}/board`]);
  });
});

describe('itemProblem / validateRequest', () => {
  it('rejects extensions the script cannot read, and items without the input kind', () => {
    expect(itemProblem(operationById('vox-stats')!, io)).toBeNull();
    expect(itemProblem(operationById('vox-stats')!, hog)).toMatch(/\.ldr not accepted/);
    expect(itemProblem(operationById('coaster-assemblies')!, lxf)).toMatch(/\.lxf not accepted/);
    expect(itemProblem(operationById('mcaddon-check')!, hog)).toMatch(/no pack/);
    expect(itemProblem(operationById('collider-treads')!, pack)).toBeNull();
    expect(itemProblem(operationById('geograde-set')!, { id: 'p', pack: 'x.mcaddon' })).toMatch(/no set/);
  });
  it('needs a selection unless the operation takes none or an option ignores it', () => {
    expect(validateRequest(operationById('entity-silhouette')!, [], {})).toContain('select at least one item for this operation');
    expect(validateRequest(operationById('lxf-gt-eval')!, [], { all: true })).toEqual([]);
    expect(validateRequest(operationById('pipeline-stamp')!, [], {})).toEqual([]);
  });
  it('needs the confirm token for danger operations, and checks enums/numbers/required', () => {
    const r2 = operationById('sync-models-r2')!;
    expect(validateRequest(r2, [hog], {})).toHaveLength(1);
    expect(validateRequest(r2, [hog], {}, 'sync-models-r2')).toEqual([]);
    expect(validateRequest(operationById('playable-pack')!, [hog], { quality: 'best' })).toEqual(['option "quality" must be one of balanced|high|ultra']);
    expect(validateRequest(operationById('playable-pack')!, [hog], { lodDistance: 'far' })).toEqual(['option "lodDistance" must be a number']);
    expect(validateRequest(operationById('entity-color-diff')!, [], {})).toEqual(['option "before" is required', 'option "after" is required']);
  });
});

describe('output parsing', () => {
  it('finds the last pretty-printed JSON object after other output', () => {
    const out = 'building…\n  scale: auto\n{\n "file": "a.io",\n "bricks": 12,\n "scale": {"scale": 1.5},\n "components": [{"id": "x"}],\n "warnings": [],\n "out": "output/bedrock-entity-qa/a.mcaddon"\n}\n';
    const p = parseJsonLast(out)!;
    expect(p['bricks']).toBe(12);
    expect(getPath(p, 'scale.scale')).toBe(1.5);
    expect(getPath(p, 'components.length')).toBe(1);
    expect(getPath(p, 'components.0.id')).toBe('x');
    expect(getPath(p, 'missing.deep')).toBeUndefined();
  });
  it('takes the LAST object when several are printed, and single-line JSON', () => {
    expect(parseJsonLast('{"a":1}\n{"a":2}')!['a']).toBe(2);
    expect(parseJsonLast('nothing here')).toBeNull();
  });
  it('parses geograde summary lines into rows', () => {
    const op = operationById('geograde')!;
    const line = '10001-1.mpd                    n=872    float=3    (1cl,0.3%) BIG=0    (0cl) side=0     disp=0     fig=0   win=2   split0=1cl/4p    ovl= 0.12%/1L3 sunk=0    dup=0    unk=0    inv=1.108\n';
    const rows = parseRegexLines('starting\n' + line + line.replace('10001-1', '71043'), op.parse.kind === 'regex-lines' ? op.parse.pattern : '', op.parse.kind === 'regex-lines' ? op.parse.groups : []);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ file: '10001-1.mpd', n: '872', float: '3', floatPct: '0.3', big: '0', fig: '0', win: '2', ovlPct: '0.12', sunk: '0', dup: '0', unk: '0', inv: '1.108' });
  });
  it('parses the mcaddon check and the lxf eval lines', () => {
    const mc = operationById('mcaddon-check')!;
    const rows = parseRegexLines('OK   a.mcaddon                    2 entities; 3 geo\nFAIL b.mcaddon                    \n       !! missing texture\n\n1/2 packs structurally valid\n', mc.parse.kind === 'regex-lines' ? mc.parse.pattern : '', mc.parse.kind === 'regex-lines' ? mc.parse.groups : []);
    expect(rows).toEqual([{ status: 'OK', pack: 'a.mcaddon', notes: '2 entities; 3 geo' }, { status: 'FAIL', pack: 'b.mcaddon', notes: '' }]);
    const lx = operationById('lxf-gt-eval')!;
    const r2 = parseRegexLines('2 lxf files × 1 variants\n   10242 shipped                GEO  93.60%  exact  80.10%  n=1000\n', lx.parse.kind === 'regex-lines' ? lx.parse.pattern : '', lx.parse.kind === 'regex-lines' ? lx.parse.groups : []);
    expect(r2).toEqual([{ set: '10242', variant: 'shipped', geoPct: '93.60', exactPct: '80.10' }]);
  });
});

describe('display', () => {
  it('quotes only what needs it', () => {
    expect(shellQuote('plain')).toBe('plain');
    expect(shellQuote('C:/git/clego/lego_sets/LDR/10001 Metro Liner.ldr')).toBe('"C:/git/clego/lego_sets/LDR/10001 Metro Liner.ldr"');
    expect(displayCommand({ argv: ['bun', 'x.ts', 'a b'], env: {} })).toBe('bun x.ts "a b"');
  });
});
