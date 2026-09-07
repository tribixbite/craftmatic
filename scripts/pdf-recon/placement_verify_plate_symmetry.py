"""Universal CAD-only symmetry verification; never reads a set model."""
import json
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary

if __name__=='__main__':
    library=PartLibrary();parsed=colored_triangles('3020',15,resolver=library.resolve)
    points=np.unique(parsed['triangles'].reshape(-1,3),axis=0);tree=cKDTree(points);rows=[]
    for name,R in [('yaw180',np.diag([-1.,1.,-1.])),('yaw90',np.array([[0.,0.,1.],[0.,1.,0.],[-1.,0.,0.]]))]:
        moved=points@R.T
        error=max(float(tree.query(moved)[0].max()),float(cKDTree(moved).query(points)[0].max()))
        rows.append(dict(part='3020',rotation=name,max_vertex_hausdorff_ldu=error))
    report=dict(truth_used=False,source='Universal LDraw CAD vertex set',geometry_files=parsed['files'],results=rows,limitations=['Embossed markings omitted if absent from library; vertex-set proof alone does not certify arbitrary triangle connectivity'])
    path=Path('output/pdf-placement-diagnosis/3020-universal-symmetry.json');path.write_text(json.dumps(report,indent=2));print(json.dumps(rows))
