"""Conservative colored-triangle equivalence for rigid group deduplication.

Retains part identity, base color, face color and triangle connectivity. Only
proper cube frames and 1e-5 LDU numerical rounding are quotiented out; vertex
sets alone are insufficient to prove equal surfaces.
"""
import hashlib
import json
import numpy as np
from placement_colored_cad import colored_triangles
from placement_part_edges import cube_rotations


def triangle_digest(triangles):
    triangles=np.round(np.asarray(triangles),5)
    triangles[triangles==0]=0
    # Canonicalize vertex order within each face, then face order.
    order=np.lexsort((triangles[:,:,2],triangles[:,:,1],triangles[:,:,0]),axis=1)
    triangles=np.take_along_axis(triangles,order[:,:,None],axis=1).reshape(-1,9)
    order=np.lexsort(tuple(triangles[:,i] for i in range(8,-1,-1)))
    return hashlib.sha256(triangles[order].tobytes()).hexdigest()


def geometry_key(items,resolver,cache):
    if not items:raise ValueError('Empty group')
    smallest=min((p,str(c)) for p,c,T in items)
    keys=[]
    for anchor_part,anchor_color,anchor_pose in items:
        if (anchor_part,str(anchor_color))!=smallest:continue
        inverse=np.linalg.inv(anchor_pose)
        pieces=[]
        for part,color,T in items:
            key=(part,str(color))
            if key not in cache:cache[key]=colored_triangles(part,color,resolver=resolver)
            parsed=cache[key];relative=inverse@T
            triangles=parsed['triangles']@relative[:3,:3].T+relative[:3,3]
            for facecolor in np.unique(parsed['colors']):
                pieces.append((part,str(color),str(facecolor),triangles[parsed['colors']==facecolor]))
        for rotation in cube_rotations():
            rows=[(p,c,f,triangle_digest(triangles@rotation[:3,:3].T)) for p,c,f,triangles in pieces]
            keys.append(json.dumps(sorted(rows)))
    return min(keys)
