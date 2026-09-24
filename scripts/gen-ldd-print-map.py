#!/usr/bin/env python3
"""
Generate web/public/ldd-print-map.json: which PRINTED LDraw head an LXFML head
really is.

An LXFML (LEGO's DBIX instruction dump) places every minifig head as design
`3626` and every mini-doll head as `28650`, with the face as an LDD
`decoration` the LDraw conversion cannot carry. The brick does carry two keys
that name the printed part:

  * `Brick@itemNos` — the LEGO ELEMENT id (design + colour + decoration), e.g.
    6454427 for 76417's goblin head.
  * `Brick@decorationBriefId` / `Part@decoration` — the decoration id, e.g.
    1029859. The same artwork in another colour is another element but the
    same decoration.

This table joins them to a printed LDraw file through data that is all
offline:

  element -> BrickLink item   Studio `elementInfoList.json` (both editions)
  element -> Rebrickable part clego `elements.csv`
  BrickLink item -> LDraw     Studio `StudioPartDefinition2.txt` (col 2 -> 4),
                              a Studio BL copy's `0 BL_Item_No` header, and the
                              official library's `0 !KEYWORDS BrickLink ...`
  Rebrickable part -> LDraw   `0 !KEYWORDS Rebrickable ...`
  decoration -> LDraw         the file most corpus elements carrying that
                              decoration resolved to (a decoration is one
                              artwork, so its other colours share it)

BrickLink numbers a head print once across moulds: 3626pb3484 == 3626cpb3484
== 3626bpb3484 (BL merged the head moulds in 2023 and kept the counters), so
head ids are compared on that shared key.

A candidate file is accepted only if it is in a library the renderer can
serve (Studio's install = the R2 seed; the upstream official + unofficial
libraries = the R2 sync) AND it is framed like the base mould: its bounding
box must equal `3626c.dat`'s (minifig) or `92198.dat`'s (mini-doll) within
FRAME_TOL_LDU, so substituting it for the plain head at the same transform
cannot move the head.

Output (flat, one row per key, so `validateTable` in lxf-parser.ts reads it
like the other LDD tables):
  { "e:<elementId>": "<printed>.dat", "d:<decorationId>": "<printed>.dat",
    "n:<elementId>": "3626cpb<N>.dat" }
`n:` rows name a minifig head that has NO LDraw print by its BrickLink print
id, in Studio's BL-copy form. Nothing ships that file, so it draws as plain
`3626c` (the alias ladder strips `pb<N>`); the name carries the head's identity
into the `.ldr` for a face-image source to key on.

Usage: python scripts/gen-ldd-print-map.py [--corpus-cache bricks.json]
  --corpus-cache: the per-brick extract of the DBIX LXFML corpus
  (element + decoration per head), needed for the `d:` rows. Without it the
  script walks C:/git/clego/lego_sets/DBIX_LXFML* itself.
"""
import csv
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

CLEGO = Path('C:/') / 'git' / 'clego'
REPO = Path(__file__).resolve().parent.parent
OUT = REPO / 'web' / 'public' / 'ldd-print-map.json'

STUDIO = CLEGO / 'extracted' / 'studio_release' / 'app' / 'ldraw'
STUDIO_DATA = [CLEGO / 'extracted' / e / 'app' / 'data' for e in ('studio_earlyaccess', 'studio_release')]
UPSTREAM = CLEGO / 'ldraw_ref'
LXFML_DIRS = [CLEGO / 'lego_sets' / d for d in ('DBIX_LXFML', 'DBIX_LXFML_CN', 'DBIX_LXFML_SHORT')]

# Part directories per library, in the order a reference is looked up.
LIBRARIES = {
    'official': [UPSTREAM / 'official' / 'parts', UPSTREAM / 'official' / 'p'],
    'unofficial': [UPSTREAM / 'unofficial' / 'parts', UPSTREAM / 'unofficial' / 'p'],
    'studio': [STUDIO / 'parts', STUDIO / 'p', STUDIO / 'UnOfficial' / 'parts', STUDIO / 'UnOfficial' / 'p'],
}
# Printed head files: minifig heads (3626b/3626c/3626p… and the 28621 mould)
# and mini-doll heads (92198).
PRINTED_HEAD = re.compile(r'^(3626[bc]?p|28621p|92198p)[0-9a-z]+$')
BASE_MOULD = {'minifig': '3626c', 'minidoll': '92198'}
FRAME_TOL_LDU = 0.6


def family_of(stem: str) -> str:
    return 'minidoll' if stem.startswith('92198') else 'minifig'


def head_key(item: str) -> str:
    """A BrickLink / file head id on the key BL numbers prints by."""
    b = item.strip().lower()
    if b.endswith('.dat'):
        b = b[:-4]
    m = re.match(r'^(?:3626[bc]?|28621)(pb?)(\w+)$', b)
    return f'3626{m.group(1)}{m.group(2)}' if m else b


# ---------------------------------------------------------------------------
# A minimal LDraw reader, for bounding boxes only.
# ---------------------------------------------------------------------------
_index: dict[str, Path] = {}          # lowercased relative name -> path
_lib_of: dict[str, set[str]] = defaultdict(set)


def build_index() -> None:
    for lib, dirs in LIBRARIES.items():
        for d in dirs:
            if not d.exists():
                continue
            for f in d.rglob('*.dat'):
                rel = f.relative_to(d).as_posix().lower()
                _index.setdefault(rel, f)
                if d.name == 'parts' and '/' not in rel:
                    _lib_of[rel[:-4]].add(lib)


_points: dict[str, list[tuple[float, float, float]]] = {}


def points_of(name: str, depth: int = 0) -> list[tuple[float, float, float]]:
    """Every triangle/quad vertex of `name`, flattened through its subfiles."""
    key = name.lower().replace('\\', '/')
    if key in _points:
        return _points[key]
    path = _index.get(key)
    pts: list[tuple[float, float, float]] = []
    if path is None or depth > 12:
        _points[key] = pts
        return pts
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        t = line.split()
        if not t:
            continue
        if t[0] == '1' and len(t) >= 15:
            x, y, z = map(float, t[2:5])
            a, b, c, d, e, f, g, h, i = map(float, t[5:14])
            for (px, py, pz) in points_of(' '.join(t[14:]), depth + 1):
                pts.append((a * px + b * py + c * pz + x, d * px + e * py + f * pz + y, g * px + h * py + i * pz + z))
        elif t[0] in ('3', '4') and len(t) >= 11:
            n = 3 if t[0] == '3' else 4
            v = list(map(float, t[2:2 + 3 * n]))
            pts.extend((v[k], v[k + 1], v[k + 2]) for k in range(0, 3 * n, 3))
    _points[key] = pts
    return pts


def bbox(name: str):
    pts = points_of(name)
    if not pts:
        return None
    return tuple(min(p[i] for p in pts) for i in range(3)), tuple(max(p[i] for p in pts) for i in range(3))


def same_frame(stem: str) -> bool:
    got, want = bbox(f'{stem}.dat'), bbox(f'{BASE_MOULD[family_of(stem)]}.dat')
    if not got or not want:
        return False
    return all(abs(got[k][i] - want[k][i]) <= FRAME_TOL_LDU for k in range(2) for i in range(3))


# ---------------------------------------------------------------------------
# Printed-head files and their BrickLink / Rebrickable keys.
# ---------------------------------------------------------------------------
def header_lines(path: Path, n: int = 30) -> list[str]:
    with open(path, encoding='utf-8', errors='replace') as f:
        return [next(f, '').strip() for _ in range(n)]


def printed_head_files():
    by_bl: dict[str, set[str]] = defaultdict(set)
    by_rb: dict[str, set[str]] = defaultdict(set)
    stems = sorted(s for s in _lib_of if PRINTED_HEAD.match(s))
    for stem in stems:
        path = _index[f'{stem}.dat']
        for s in header_lines(path):
            if s.startswith('0 BL_Item_No'):
                by_bl[head_key(s.split()[-1])].add(stem)
            if s.startswith('0 !KEYWORDS'):
                for tok in s[len('0 !KEYWORDS'):].split(','):
                    w = tok.split()
                    if len(w) == 2 and w[0].lower() == 'bricklink':
                        by_bl[head_key(w[1])].add(stem)
                    elif len(w) == 2 and w[0].lower() == 'rebrickable':
                        by_rb[w[1].lower()].add(stem)
    # Studio's own BL -> LDraw column.
    spd = STUDIO_DATA[0] / 'StudioPartDefinition2.txt'
    with open(spd, encoding='utf-8', errors='replace') as f:
        f.readline()
        for line in f:
            c = line.rstrip('\n').split('\t')
            if len(c) > 4 and c[2].strip() and c[4].lower().endswith('.dat'):
                stem = c[4][:-4].strip().lower()
                if PRINTED_HEAD.match(stem) and stem in _lib_of:
                    by_bl[head_key(c[2])].add(stem)
    return stems, by_bl, by_rb


def preference(stem: str):
    """Official LDraw first (curated, CC BY), then upstream unofficial, then a
    Studio BL copy; the current hollow-stud mould before older ones."""
    libs = _lib_of[stem]
    rank = 0 if 'official' in libs else 1 if 'unofficial' in libs else 2
    mould = 0 if stem.startswith(('3626c', '92198')) else 1
    return (rank, mould, stem)


def main() -> int:
    argv = sys.argv[1:]
    cache = argv[argv.index('--corpus-cache') + 1] if '--corpus-cache' in argv else None
    build_index()
    stems, by_bl, by_rb = printed_head_files()
    framed = {s for s in stems if same_frame(s)}
    print(f'printed head files: {len(stems)} served, {len(framed)} framed like their base mould '
          f'({len(stems) - len(framed)} rejected)')

    def pick(cands):
        ok = sorted((c for c in cands if c in framed), key=preference)
        return ok[0] if ok else None

    # element -> candidate BL / RB ids
    el_bl: dict[str, set[str]] = defaultdict(set)
    for d in STUDIO_DATA:
        p = d / 'elementInfoList.json'
        if p.exists():
            for r in json.load(open(p, encoding='utf-8')):
                el_bl[r['elementId']].add(r['blItemNo'])
    el_rb: dict[str, str] = {}
    with open(CLEGO / 'elements.csv', newline='', encoding='utf-8', errors='replace') as f:
        for r in csv.DictReader(f):
            el_rb.setdefault(r['element_id'], r['part_num'])

    rows: dict[str, str] = {}
    via = Counter()
    for el in sorted(set(el_bl) | set(el_rb)):
        hit = None
        for bl in sorted(el_bl.get(el, ())):
            hit = pick(by_bl.get(head_key(bl), ()))
            if hit:
                via['bl'] += 1
                break
        if not hit and el in el_rb:
            hit = pick(by_rb.get(el_rb[el].lower(), ()))
            if hit:
                via['rb'] += 1
        if hit:
            rows[f'e:{el}'] = f'{hit}.dat'
            continue
        # No LDraw print: keep the head's IDENTITY as Studio's BrickLink-copy
        # name (`3626cpb3484.dat`). No library ships it today, so every reader
        # strips the print suffix and draws plain `3626c` exactly as before
        # (`partAliasCandidates`), but the source now says which print the head
        # is, which a face-image source (route 2) keys on. Refused when a file of
        # that name exists but is framed differently (Studio's `3626cpb2305` sits
        # 24 LDU off): a reader would then load it, misplaced.
        for bl in sorted(el_bl.get(el, ())):
            m = re.match(r'^3626[bc]?pb(\d+)$', bl.lower())
            if m:
                name = f'3626cpb{m.group(1)}'
                if name in _lib_of and name not in framed:
                    continue
                rows[f'n:{el}'] = f'{name}.dat'
                via['name'] += 1
                break
    print(f'element rows: {sum(1 for k in rows if k.startswith("e:"))} printed, '
          f'{sum(1 for k in rows if k.startswith("n:"))} identity-only ({dict(via)})')

    # decoration -> file, by the corpus's own element/decoration pairs.
    pairs = corpus_head_pairs(cache)
    votes: dict[str, Counter] = defaultdict(Counter)
    for items, dec in pairs:
        for it in items:
            f = rows.get(f'e:{it}')  # only real prints vote; an identity name is not a print
            if f and dec:
                votes[dec][f] += 1
    for dec, c in sorted(votes.items()):
        f, n = c.most_common(1)[0]
        if len(c) > 1:
            print(f'  decoration {dec}: elements disagree {dict(c)}; taking {f}')
        rows[f'd:{dec}'] = f
    print(f'decoration rows: {sum(1 for k in rows if k.startswith("d:"))} from {len(pairs)} corpus heads')

    OUT.write_bytes((json.dumps(dict(sorted(rows.items())), separators=(',', ':')) + '\n').encode('utf-8'))
    print(f'wrote {OUT} ({OUT.stat().st_size:,} bytes, {len(rows)} rows)')
    return 0


def corpus_head_pairs(cache: str | None) -> list[tuple[list[str], str]]:
    """(element ids, decoration id) for every decorated head brick in the corpus."""
    heads = {'3626', '28650', '92198', '28621'}
    out = []
    if cache:
        for stem, bdes, pdes, items, brief, pdecs, mat in json.load(open(cache, encoding='utf-8'))['rows']:
            if not ({bdes} | set(pdes)) & heads:
                continue
            dec = decoration_id(brief, pdecs)
            if dec:
                out.append(([i.strip() for i in items.split(',') if i.strip()], dec))
        return out
    attr = re.compile(r'(\w+)="([^"]*)"')
    for d in LXFML_DIRS:
        for f in sorted(d.glob('*.lxfml')) if d.exists() else ():
            cur = None
            with open(f, encoding='utf-8', errors='replace') as fh:
                for line in fh:
                    s = line.lstrip()
                    if s.startswith('<Brick '):
                        a = dict(attr.findall(s))
                        cur = [a.get('designID', '').split(';')[0], a.get('itemNos', ''), a.get('decorationBriefId', ''), [], []]
                    elif s.startswith('<Part ') and cur is not None:
                        a = dict(attr.findall(s))
                        cur[3].append(a.get('designID', '').split(';')[0])
                        cur[4].append(a.get('decoration', ''))
                    elif s.startswith('</Brick>') and cur is not None:
                        if ({cur[0]} | set(cur[3])) & heads:
                            dec = decoration_id(cur[2], cur[4])
                            if dec:
                                out.append(([i.strip() for i in cur[1].split(',') if i.strip()], dec))
                        cur = None
    return out


def decoration_id(brief: str, part_decorations) -> str:
    """`1029859;A` -> 1029859; else the first `Part@decoration` token's id."""
    if brief:
        return brief.split(';')[0].strip()
    for pd in part_decorations:
        if pd:
            return pd.split('_')[0].strip()
    return ''


if __name__ == '__main__':
    sys.exit(main())
