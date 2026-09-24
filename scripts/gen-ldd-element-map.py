#!/usr/bin/env python3
"""
Generate web/public/ldd-element-map.json: LEGO ELEMENT id -> LDraw part stem,
for the `.lxf` loader's ELEMENT fallback (lxf-parser.ts `buildLxfPlacements`).

Why an element table
--------------------
An LXFML `<Brick>` names its mould twice: `designID` (LDD's design number) and
`itemNos` (the LEGO ELEMENT ids, one per colour/print). When neither alignment
table names the design, the loader draws `<designID>.dat` at identity — and
for designs whose LDD number is not an LDraw file that is a MISSING part. The
mini-doll heads are the case clego met: LDD 28650 is LDraw 92198, and 42703's
dolls came out headless until clego's converter (`reconvert_dbix.py`
`Resolver.resolve_element`) resolved the brick's element through Rebrickable's
`elements.csv` (element_id -> part_num, which is LDraw-numbered). This file is
that same data under that same rule, so both repos resolve an element the same
way:

  * the raw Rebrickable `part_num`, then with a print/pattern suffix stripped
    (`92198pr0411` -> `92198`), then with an assembly suffix stripped
    (`37364c03` -> `37364`); the first that the UPSTREAM library ships wins
    (the viewer draws upstream, not Studio's copy);
  * used only for a brick with ONE part (a multi-part brick's elements name the
    assembly, not the part) — enforced by the loader.

Size: only rows that can change a placement are kept. A row is dropped when
Rebrickable records the element's LDD `design_id` AND that design already
resolves without it (a row in `ldd-part-map.json` or `ldd-measured-align.json`,
or an upstream `<design>.dat`), or the element resolves to its own design id.
Rows with no recorded `design_id` are kept: their design is only known at load
time, and the loader still asks the alignment tables first.

Source: C:/git/clego/elements.csv (Rebrickable export, 2026-08-28).
Output shape: { "<element id>": "<ldraw stem>", ... }
"""
import csv
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ELEMENTS = Path(r'C:\git\clego\elements.csv')
UPSTREAM_PART_DIRS = (
    Path(r'C:\git\clego\ldraw_ref\official\parts'),
    Path(r'C:\git\clego\ldraw_ref\unofficial\parts'),
)
PART_MAP = REPO / 'web' / 'public' / 'ldd-part-map.json'
MEASURED = REPO / 'web' / 'public' / 'ldd-measured-align.json'
OUT = REPO / 'web' / 'public' / 'ldd-element-map.json'

PRINT_SUFFIX = re.compile(r'(pr|pat)[0-9a-z]*$')
ASSEMBLY_SUFFIX = re.compile(r'c\d+$')


def candidates(part_num: str) -> list[str]:
    """clego reconvert_dbix.Resolver.resolve_element's candidate ladder."""
    out = [part_num]
    stripped = PRINT_SUFFIX.sub('', part_num)
    if stripped != part_num:
        out.append(stripped)
    for c in list(out):
        s2 = ASSEMBLY_SUFFIX.sub('', c)
        if s2 != c:
            out.append(s2)
    return [c for c in out if c]


def table_keys(path: Path) -> set[str]:
    d = json.loads(path.read_text(encoding='utf-8'))
    return set(d.get('entries', d))


def main() -> None:
    stems = {f.stem.lower(): f.stem for d in UPSTREAM_PART_DIRS for f in d.glob('*.dat')}
    resolved_designs = table_keys(PART_MAP) | table_keys(MEASURED)
    out: dict[str, str] = {}
    kept_no_design = dropped_resolved = 0
    with ELEMENTS.open(newline='', encoding='utf-8', errors='replace') as f:
        for row in csv.DictReader(f):
            eid, pn, design = row.get('element_id', ''), row.get('part_num', ''), row.get('design_id', '')
            if not eid or not pn or eid in out:
                continue
            stem = next((c for c in candidates(pn) if c.lower() in stems), None)
            if stem is None:
                continue
            if design:
                if design in resolved_designs or design.lower() in stems or design.lower() == stem.lower():
                    dropped_resolved += 1
                    continue
            else:
                kept_no_design += 1
            out[eid] = stem.lower()
    text = json.dumps(dict(sorted(out.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0)),
                      separators=(',', ':'))
    OUT.write_bytes(text.encode('utf-8') + b'\n')
    print(f'{len(out)} element rows ({kept_no_design} with no recorded design id); '
          f'{dropped_resolved} dropped as already resolved; {OUT.stat().st_size} bytes -> {OUT}')


if __name__ == '__main__':
    main()
