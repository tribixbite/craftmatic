#!/usr/bin/env python3
"""Generate web/public/ldraw-color-names.json (color id -> human name) from
the canonical LDConfig.ldr. Names use underscores in LDConfig; convert to
spaces. Used by the LEGO-tab parts-list (BOM) CSV export."""
import json, re
from pathlib import Path
SRC = Path(r'C:\git\clego\extracted\studio_release\app\ldraw\LDConfig.ldr')
OUT = Path(r'C:\git\craftmatic\web\public\ldraw-color-names.json')
names = {}
for line in SRC.read_text(encoding='utf-8', errors='replace').splitlines():
    m = re.match(r'\s*0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s', line)
    if m:
        names[int(m.group(2))] = m.group(1).replace('_', ' ')
OUT.write_text(json.dumps(names, separators=(',', ':')), encoding='utf-8')
print(f'Wrote {len(names)} color names -> {OUT} ({OUT.stat().st_size} bytes)')
for k in (0,1,4,15,71,72,70,272):
    print(f'  {k}: {names.get(k)}')
