"""Audit strict universal geometry for PDF BOM parts; no model truth."""
import json
from pathlib import Path
import sys
import numpy as np
from placement_strict_geometry import StrictGeometry
from placement_part_library import PartLibrary
sys.path.insert(0,'C:/git/clego')
from dbix_settle import part_points,_find_dat
from recon_v8.partrender import part_tris

out=Path('output/pdf-placement-vector/geometry-audit');out.mkdir(parents=True,exist_ok=True)
source=Path('output/pdf-placement-beam/40377-contacts-six-v1/inventory.json')
inventory=json.loads(source.read_text());parts={}
for row in inventory['records']:
    if 'part' not in row:continue
    p=row['part'];parts.setdefault(p,dict(qty=0,colors=set()))
    parts[p]['qty']+=row['qty'];parts[p]['colors'].add(row['color'])
library=PartLibrary();strict=StrictGeometry(library);records=[]
for p,data in sorted(parts.items()):
    row=dict(part=p,qty=data['qty'],colors=sorted(data['colors']))
    old_path=_find_dat(p+'.dat');row['legacy_resolved_path']=str(old_path) if old_path else None
    old_points=np.asarray(part_points(p));old_triangles=part_tris(p).reshape(-1,3)
    row['legacy_points_bbox']=[old_points.min(0).tolist(),old_points.max(0).tolist()]
    row['legacy_triangles_bbox']=[old_triangles.min(0).tolist(),old_triangles.max(0).tolist()]
    try:
        path=library.resolve(p);geometry=strict.load(p);points=geometry['triangles'].reshape(-1,3)
        bounds=np.array([points.min(0),points.max(0)])
        row.update(strict_ok=True,resolved_path=str(path),resolved_alias=path.stem.lower()!=p.lower(),
            strict_bbox=bounds.tolist(),triangle_count=len(geometry['triangles']),dependencies=len(geometry['files']),
            legacy_points_bbox_max_error=float(np.max(np.abs(bounds-np.asarray(row['legacy_points_bbox'])))),
            legacy_triangles_bbox_max_error=float(np.max(np.abs(bounds-np.asarray(row['legacy_triangles_bbox'])))))
    except (FileNotFoundError,ValueError) as error:row.update(strict_ok=False,error=str(error))
    records.append(row)
result=dict(input_inventory=str(source),protocol='PDF BOM and universal geometry only; no model truth',
    unresolved_pdf_records=[r for r in inventory['records'] if 'part' not in r],records=records,
    summary=dict(unique_parts=len(records),instances=sum(r['qty'] for r in records),
        strict_available=sum(r['strict_ok'] for r in records),
        strict_available_instances=sum(r['qty'] for r in records if r['strict_ok']),
        missing=[r['part'] for r in records if not r['strict_ok']],
        aliases=[r['part'] for r in records if r.get('resolved_alias')],
        point_bbox_differences=[r['part'] for r in records if r.get('legacy_points_bbox_max_error',0)>.5]))
(out/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
