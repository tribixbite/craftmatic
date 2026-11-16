#!/usr/bin/env python3
"""
Generate web/src/engine/bricklink-ldraw.ts: the LDraw part a BrickLink item number IS, where no library ships a file
under the BrickLink number and Studio's own exports prove the two are drawn at the same matrix.

Why: sources in the BrickLink lineage (Studio `.io` exports, clego's IOModel2V2 conversions of their model2.ldr) name
some parts by BrickLink item numbers no library ships: assemblies (`55423c01`, train wheel with its rubber ring),
old catalogue numbers (`x187`, `crssprt02`) and hose lengths (`78c02`). The suffix ladder cannot reach them (the
number is not a suffix away), so each placement shipped as its bounding box (910035 Logging Railway: 12 `55423c01`
wheels, generality census 2026-11-16).

LDraw says which BrickLink item each of its parts is, in its header: `55423.dat` carries
`0 !KEYWORDS ... BrickLink 55423c01 ...`. A keyword is the IDENTITY; the FRAME is proved separately, by Studio itself:
every `.io` archive in the corpus holds `model2.ldr` (BrickLink names) and `model.ldr` (the LDraw names Studio wrote
for the SAME placements), so a BrickLink name X and an LDraw name S at an identical matrix (position and rotation to
0.01) is Studio drawing X as S in S's frame. A row X -> T is written only when
  * X is in no library tree and no suffix-ladder hop of it is (the ladder already serves those),
  * X is not a name `synthesizedPartText` generates (`75c<NN>`),
  * exactly one library part T names X in its `!KEYWORDS BrickLink`,
  * Studio's exports pair X with a name S at least once, every pairing of X names the same S, and S is T or S is a
    Studio file whose sub-part lines are T's own (Studio's `UnOfficial/parts/u9241.dat` composite of the wheel and its
    ring is line for line LDraw's `55423.dat`).
A keyword with no pairing in any `.io`, or a pairing that disagrees (`731c06`: keyword 76138, Studio 41838), is left
out and counted, never guessed.

Usage: python -I scripts/gen-bricklink-ldraw.py [--pairs=<cached pairs json>] [--save-pairs=<json>]
"""
import collections
import glob
import json
import re
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / 'web' / 'src' / 'engine' / 'bricklink-ldraw.ts'
CLEGO = Path('C:/git/clego')
STUDIO = CLEGO / 'extracted/studio_release/app/ldraw'
REF = CLEGO / 'ldraw_ref'
PART_TREES = [STUDIO / 'parts', STUDIO / 'UnOfficial/parts', REF / 'official/parts', REF / 'unofficial/parts']
KEYWORD_TREES = [REF / 'official/parts', REF / 'unofficial/parts', STUDIO / 'parts']
CORPUS = CLEGO / 'lego_sets'
IO_PASSWORD = b'soho0909'
TYPE1 = re.compile(r'^\s*1\s+\S+\s+((?:\S+\s+){12})(.+?)\s*$')


def ladder(stem: str) -> list[str]:
    """The suffix ladder of `partAliasCandidates` (ldraw-part-aliases.ts), without its data rungs."""
    out, s = [], stem
    m = re.match(r'^rename_(.+)$', s)
    if m:
        s = m.group(1)
        out.append(s)
    for _ in range(4):
        m = re.match(r'^(.+?\d[a-z]?)(?:d\d+|v\d+|p[a-z]{0,2}\d+[a-z]?\d*)$', s) or re.match(r'^(.*\d[a-z]?)[a-z]$', s)
        if not m or m.group(1) in out:
            break
        s = m.group(1)
        out.append(s)
    return out


def library_names() -> dict[str, list[Path]]:
    names: dict[str, list[Path]] = collections.defaultdict(list)
    for tree in PART_TREES:
        for f in tree.iterdir():
            if f.suffix.lower() == '.dat':
                names[f.stem.lower()].append(f)
    return names


def keyword_targets() -> dict[str, set[str]]:
    kw: dict[str, set[str]] = collections.defaultdict(set)
    for tree in KEYWORD_TREES:
        for f in tree.iterdir():
            if f.suffix.lower() != '.dat':
                continue
            with open(f, encoding='utf-8', errors='replace') as h:
                for i, line in enumerate(h):
                    if i > 40:
                        break
                    if line.startswith('0 !KEYWORDS'):
                        for m in re.finditer(r'BrickLink\s+([A-Za-z0-9_.-]+)', line):
                            kw[m.group(1).lower().rstrip(',.')].add(f.stem.lower())
    return kw


def io_pairs() -> dict[str, collections.Counter]:
    """{model2 name: Counter(model name)} over every corpus `.io`, paired by identical matrix."""
    pairs: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)

    def placements(text: str) -> dict[tuple, list[str]]:
        out: dict[tuple, list[str]] = collections.defaultdict(list)
        for line in text.splitlines():
            m = TYPE1.match(line)
            if m:
                key = tuple(round(float(v), 2) for v in m.group(1).split())
                out[key].append(m.group(2).lower().replace('\\', '/').removesuffix('.dat'))
        return out

    for p in glob.glob(str(CORPUS / '**' / '*.io'), recursive=True):
        try:
            z = zipfile.ZipFile(p)

            def read(name: str) -> str:
                try:
                    return z.read(name).decode('utf-8', 'replace')
                except RuntimeError:
                    return z.read(name, pwd=IO_PASSWORD).decode('utf-8', 'replace')
            a, b = placements(read('model.ldr')), placements(read('model2.ldr'))
        except Exception:
            continue
        for key, names2 in b.items():
            names1 = a.get(key)
            if names1 and len(names1) == 1 and len(names2) == 1:
                pairs[names2[0]][names1[0]] += 1
    return pairs


def subpart_lines(path: Path) -> list[str]:
    """A file's type-1 lines, numbers normalised, for a line-for-line comparison of two composites."""
    out = []
    with open(path, encoding='utf-8', errors='replace') as h:
        for line in h:
            f = line.split()
            if len(f) >= 15 and f[0] == '1':
                out.append(' '.join([f[1], *(f'{float(v):.3f}' for v in f[2:14]), f[14].lower()]))
    return sorted(out)


def main() -> None:
    args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    lib = library_names()
    kw = keyword_targets()
    if 'pairs' in args:
        pairs = {k: collections.Counter(v) for k, v in json.load(open(args['pairs']))['pairs'].items()}
    else:
        pairs = io_pairs()
        if 'save-pairs' in args:
            json.dump({'pairs': {k: dict(v) for k, v in pairs.items()}}, open(args['save-pairs'], 'w'))
    rows: dict[str, tuple[str, int, str]] = {}
    skipped = collections.Counter()
    for x, targets in sorted(kw.items()):
        if x in lib or any(h in lib for h in ladder(x)) or re.fullmatch(r'75c\d\d', x):
            continue
        if len(targets) != 1:
            skipped['ambiguous keyword'] += 1
            continue
        t = next(iter(targets))
        if t not in lib:
            skipped['target missing'] += 1
            continue
        seen = pairs.get(x)
        if not seen:
            skipped['no Studio pairing'] += 1
            continue
        if len(seen) != 1:
            skipped['Studio pairs disagree'] += 1
            continue
        s, n = next(iter(seen.items()))
        if s == t:
            rows[x] = (t, n, 'same name')
            continue
        studio_files = [p for p in lib.get(s, []) if STUDIO in p.parents]
        if studio_files and any(subpart_lines(p) == subpart_lines(lib[t][0]) and subpart_lines(p) for p in studio_files):
            rows[x] = (t, n, f'Studio {s} is line for line {t}')
            continue
        skipped['Studio draws another part'] += 1
    out = [
        '// AUTO-GENERATED by scripts/gen-bricklink-ldraw.py - do not edit by hand.',
        '// BrickLink item number -> the LDraw part that IS it (its `!KEYWORDS BrickLink`), for names no library ships,',
        "// each proved by Studio's own .io exports (model2.ldr's BrickLink name and model.ldr's LDraw name at one matrix).",
        f'// {len(rows)} rows; left out: ' + ', '.join(f'{k} {v}' for k, v in sorted(skipped.items())) + '.',
        '',
        '/** BrickLink item number (lower case) -> LDraw part name; the comment is the Studio pairing count and how it matched. */',
        'export const BRICKLINK_LDRAW: Readonly<Record<string, string>> = Object.freeze({',
    ]
    for x, (t, n, how) in sorted(rows.items()):
        out.append(f'  {json.dumps(x)}: {json.dumps(t)}, // {n} Studio pairing(s), {how}')
    out += ['});', '']
    OUT.write_text('\n'.join(out), encoding='utf-8', newline='\n')
    print(f'wrote {OUT}: {len(rows)} rows; skipped {dict(skipped)}')


if __name__ == '__main__':
    main()
