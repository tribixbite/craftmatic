"""Universal colored-CAD group keys quotienting proper global cube frames."""
import hashlib,json
from pathlib import Path
import numpy as np
from placement_arrow_contacts import read_items
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary
from placement_beam import rotations


def geometry_key(items,library,cache):
    anchor=np.linalg.inv(items[0][2]);pieces=[]
    for part,color,T in items:
        k=(part,int(color))
        if k not in cache:cache[k]=colored_triangles(part,color,resolver=library.resolve)
        parsed=cache[k];T=anchor@T
        for facecolor in np.unique(parsed['colors']):
            points=parsed['triangles'][parsed['colors']==facecolor].reshape(-1,3)
            pieces.append((part,int(color),int(facecolor),points@T[:3,:3].T+T[:3,3]))
    keys=[]
    for R in rotations():
        rows=[]
        for part,color,facecolor,points in pieces:
            points=np.unique(np.round(points@R[:3,:3].T,5),axis=0)
            points[points==0]=0
            rows.append((part,color,facecolor,hashlib.sha256(points.tobytes()).hexdigest()))
        keys.append(json.dumps(sorted(rows)))
    return min(keys)


if __name__=='__main__':
    root=Path('output/pdf-placement-diagnosis/allocated-pair-page7');library=PartLibrary();cache={};groups={}
    for path in sorted(root.glob('group_*.ldr')):
        k=geometry_key(read_items(path),library,cache);groups.setdefault(k,[]).append(path.name)
    report=dict(truth_used=False,protocol='Part ID/basecolor/facecolor vertex sets after anchor normalization and24 proper global cube rotations; rounded1e-5LDU; no arbitrary truncation or truth selection',
        input_groups=sum(map(len,groups.values())),unique_groups=len(groups),classes=list(groups.values()),limitations=['Structural CAD vertex equivalence; triangulation connectivity is not a general mesh-isomorphism proof','Keep earliest PDF-ranked representative within each class only'])
    out=root/'geometry-dedup.json';out.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
