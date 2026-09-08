"""Universal unprinted 1x1 brick rotational geometry audit, no set truth."""
import json,hashlib
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary


if __name__=='__main__':
    parsed=colored_triangles('3005',1,resolver=PartLibrary().resolve);triangles=parsed['triangles'];points=np.unique(triangles.reshape(-1,3),axis=0);tree=cKDTree(points);rows=[]
    Q=np.array([[0.,0.,1.],[0.,1.,0.],[-1.,0.,0.]])
    def triangle_keys(t):return sorted(tuple(sorted(tuple(np.round(v,6)) for v in tri)) for tri in t)
    original=triangle_keys(triangles)
    for turns in (1,2,3):
        R=np.linalg.matrix_power(Q,turns);moved=points@R.T
        error=max(float(tree.query(moved)[0].max()),float(cKDTree(moved).query(points)[0].max()))
        rows.append(dict(yaw_degrees=90*turns,max_vertex_hausdorff_ldu=error,full_triangle_connectivity_invariant=triangle_keys(triangles@R.T)==original))
    report=dict(part='3005',truth_used=False,geometry_files=parsed['files'],results=rows)
    out=Path('output/pdf-placement-diagnosis/3005-universal-symmetry.json');out.write_text(json.dumps(report,indent=2));print(json.dumps(rows))
