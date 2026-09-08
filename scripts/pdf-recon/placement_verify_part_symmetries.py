"""Full colored-triangle invariance under all24 proper cube rotations."""
import argparse,json
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary
from placement_beam import rotations


def verify(part):
    parsed=colored_triangles(part,15,resolver=PartLibrary().resolve);triangles=parsed['triangles'];colors=parsed['colors']
    points=np.unique(triangles.reshape(-1,3),axis=0);tree=cKDTree(points)
    def keys(ts):return sorted((int(color),tuple(sorted(tuple(np.round(v,6)) for v in tri))) for color,tri in zip(colors,ts))
    baseline=keys(triangles);rows=[]
    for T in rotations():
        R=T[:3,:3];rotated=points@R.T
        distance=max(float(tree.query(rotated)[0].max()),float(cKDTree(rotated).query(points)[0].max()))
        rows.append(dict(rotation=R.tolist(),identity=bool(np.array_equal(R,np.eye(3))),max_vertex_hausdorff_ldu=distance,full_colored_triangle_invariant=keys(triangles@R.T)==baseline))
    assert any(r['identity'] and r['full_colored_triangle_invariant'] for r in rows)
    return dict(part=part,truth_used=False,method='Full colored triangle connectivity, sorted vertices, six-decimal LDU comparison; all24 proper rotations',geometry_files=parsed['files'],rotations=rows)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('parts',nargs='+');a=p.parse_args()
    for part in a.parts:
        result=verify(part);out=Path('output/pdf-placement-diagnosis')/(part+'-full-symmetry.json');out.write_text(json.dumps(result,indent=2))
        print(json.dumps(dict(part=part,allowed=[r['rotation'] for r in result['rotations'] if r['full_colored_triangle_invariant']])))
