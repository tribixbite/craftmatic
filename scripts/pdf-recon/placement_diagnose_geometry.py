"""Read-only cached surface/fresh triangle geometry audit."""
from pathlib import Path
import hashlib,json,pickle,sys
import numpy as np
import cv2
sys.path.insert(0,'C:/git/clego')
from dbix_settle import _find_dat,_parse_dat,_sample_tris
from pose_score import read_parts

OUT=Path('output/pdf-placement-diagnosis')

def bbox(a):
    a=np.asarray(a).reshape(-1,3)
    return {'count':len(a),'min':a.min(0).tolist(),'max':a.max(0).tolist(),'extent':np.ptp(a,axis=0).tolist()} if len(a) else None

if __name__=='__main__':
    cachepath=Path('C:/git/clego/.part_points_cache.pkl')
    before=hashlib.sha256(cachepath.read_bytes()).hexdigest()
    cache=pickle.loads(cachepath.read_bytes())
    rows=[];trismap={}
    for part in ['99780','15571','2420']:
        path=_find_dat(part+'.dat');tris=_parse_dat(path);points=_sample_tris(tris)
        cached=np.asarray(cache.get(part,[]))
        fresh=np.asarray(points)
        trismap[part]=np.asarray(tris)
        rows.append({'part':part,'source':str(path),'source_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'cached':bbox(cached),'fresh_sampled':bbox(fresh),'fresh_triangles':bbox(tris),'cached_equals_fresh':bool(cached.shape==fresh.shape and np.array_equal(cached,fresh))})
    parts=read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')[:4]
    scene=[]
    for part,color,p,R in parts:
        tris=trismap[part]@R.T+p
        scene.append(tris)
    tris=np.concatenate(scene)
    # Fixed OMR frame and documented camera, no silhouette-guided frame choice.
    M=np.array([[1,0,-1],[.5,1,.5]])
    px=tris@M.T;lo=px.reshape(-1,2).min(0);hi=px.reshape(-1,2).max(0)
    image=np.full((300,300),255,np.uint8)
    pixels=np.rint((px-(lo+hi)/2)*260/max(hi-lo)+149.5).astype(np.int32)
    for tri in pixels:cv2.fillConvexPoly(image,tri,0)
    cv2.imwrite(str(OUT/'truth-first4-fresh-triangles.png'),image)
    after=hashlib.sha256(cachepath.read_bytes()).hexdigest()
    report={'scope':'Read-only cache-versus-fresh geometry evaluation; no cache overwritten','cache_sha256_before':before,'cache_sha256_after':after,'parts':rows,'truth_prefix_multiset':[p[0] for p in parts],'truth_assembly_triangle_bbox':bbox(tris)}
    (OUT/'geometry-audit.json').write_text(json.dumps(report,indent=2))
    print(OUT/'geometry-audit.json')
