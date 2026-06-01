#!/usr/bin/env python3
"""
Generate web/public/ldd-part-map.json from BrickLink Studio's ldraw.xml.

Maps an LDD/LXFML designID → the correct LDraw part filename PLUS the
per-part origin-alignment transform (axis-angle rotation + translation in
LDD units) that aligns the LDraw part origin onto the LDD part origin.

This is the data the .lxf loader needs to place parts correctly (issue #108).
Angle is stored verbatim in RADIANS (the XML's angle values are radians, e.g.
1.570796 = pi/2 — do NOT deg->rad convert them).

Output shape (compact, arrays not objects to keep file small):
  { "<designID>": ["<ldrawFile>", tx, ty, tz, angle, ax, ay, az], ... }
"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

XML = Path(r'C:\git\clego\extracted\studio_release\app\data\ldraw.xml')
OUT = Path(r'C:\git\craftmatic\web\public\ldd-part-map.json')


def r(v: float) -> float:
    """Round to 6 sig-ish places, collapse -0.0 → 0, drop trailing noise."""
    x = round(float(v), 6)
    return 0.0 if x == 0 else x


def main():
    root = ET.parse(XML).getroot()
    part_map: dict[str, list] = {}

    for child in root:
        if child.tag == 'Transformation':
            if child.get('type', '') == 'to_lego':
                continue  # reverse mapping, skip
            lego = child.get('lego', '')
            ldraw = child.get('ldraw', '')
            if not (lego and ldraw):
                continue
            if lego in part_map:
                continue  # first mapping wins
            try:
                tx = r(child.get('tx', 0)); ty = r(child.get('ty', 0)); tz = r(child.get('tz', 0))
                angle = r(child.get('angle', 0))
                ax = r(child.get('ax', 1)); ay = r(child.get('ay', 0)); az = r(child.get('az', 0))
            except ValueError:
                continue
            part_map[lego] = [ldraw, tx, ty, tz, angle, ax, ay, az]

        elif child.tag == 'Assembly':
            lego = child.get('lego', '')
            ldraw = child.get('ldraw', '')
            if lego and ldraw and lego not in part_map:
                part_map[lego] = [ldraw, 0, 0, 0, 0, 1, 0, 0]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(part_map, separators=(',', ':')), encoding='utf-8')
    size_kb = OUT.stat().st_size / 1024
    print(f'Wrote {len(part_map)} part mappings -> {OUT} ({size_kb:.0f} KB)')
    # spot checks
    for k in ('3001', '3049', '60583', '6014'):
        print(f'  {k}: {part_map.get(k)}')


if __name__ == '__main__':
    main()
