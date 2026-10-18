"""Per-pixel CUDA depth and balanced color scoring; legacy scorer unchanged.

Lighting is camera-relative so rotating a model together with the inverse
camera does not change its appearance score. Geometry, projection, and colors
remain deterministic universal-CAD/PDF inputs; no truth model or VLM.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from placement_colored_scene_score import ColoredSceneScorer
from placement_colored_cad import _rgb,nativecolor_render
from placement_cuda_triangles import TriangleRasterizer
from placement_balanced_color_metric import balanced_color_metric


class GpuColoredSceneScorer(ColoredSceneScorer):
    def __init__(self,scene,resolver=None,span_tolerance=.35,max_projection_cache=4096,plane_depth=False):
        super().__init__(scene,resolver,span_tolerance,max_projection_cache)
        self.plane_depth=bool(plane_depth)
        if self.plane_depth:
            from placement_cuda_planes import PlaneTriangleRasterizer
            self.rasterizer=PlaneTriangleRasterizer()
        else:self.rasterizer=TriangleRasterizer()
        self.last_rgb=None;self.last_mask=None

    def _project_part(self,part,color,T,projection):
        value=super()._project_part(part,color,T,projection)
        if 'vertex_depth' not in value:
            parsed=self.geometry[(part,str(color))]
            triangles=parsed['triangles']@np.asarray(T)[:3,:3].T
            camera=value['camera'];M=np.asarray(projection,float)
            right=M[0]/np.linalg.norm(M[0]);down=M[1]/np.linalg.norm(M[1])
            light=-.5*right-.8*down+camera;light/=np.linalg.norm(light)
            normals=np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0])
            normals/=np.maximum(1e-8,np.linalg.norm(normals,axis=1,keepdims=True))
            normals*=np.where(normals@camera>=0,1.,-1.)[:,None]
            illumination=np.round(np.maximum(0.,normals@light),8)
            base=np.stack([_rgb(c) for c in parsed['colors']])
            value['shaded']=np.clip(base*(.42+.58*illumination[:,None])+40*illumination[:,None],0,255).astype(np.uint8)
            value['vertex_depth']=triangles@camera
        return value

    def score(self,items,projection,renderpath=None):
        self.calls+=1;M=np.asarray(projection,float);pieces=[];lows=[];highs=[]
        colors_allowed=set()
        for part,color,T in items:
            colors_allowed.add(int(color));T=np.asarray(T,float)
            p=self._project_part(part,color,T,M);offset=M@T[:3,3]
            pieces.append((p,offset,float(p['camera']@T[:3,3])))
            lows.append(p['lo']+offset);highs.append(p['hi']+offset)
        if not pieces:raise ValueError('Empty assembly')
        lo=np.min(lows,axis=0);hi=np.max(highs,axis=0);span=hi-lo
        error=np.abs(span-self.target_span)/self.target_span
        origin=self.target_center-(lo+hi)/2
        evidence=dict(span_error=error.tolist(),projected_span=span.tolist(),target_span=self.target_span.tolist(),
            image_origin=origin.tolist(),rescaled=False,certified=False,renderer='CUDA interpolated per-pixel depth',
            lighting='camera-relative',metric='balanced allowed base-color region IoU',plane_depth=self.plane_depth)
        if np.max(error)>self.span_tolerance:
            self.rejected+=1;evidence.update(score=-1.,bbox_rejected=True,rejected='Physical projected span mismatch')
            self.last_rgb=None;self.last_mask=None;return evidence
        xy=np.concatenate([p['xy']+off+origin for p,off,depth in pieces])
        depth=np.concatenate([p['vertex_depth']+depth for p,off,depth in pieces])
        triangles=np.concatenate((xy,depth[:,:,None]),axis=2)
        # Remove floating permutation noise far below native PDF precision.
        if not self.plane_depth:triangles=np.round(triangles,6).astype(np.float32)
        colors=np.concatenate([p['shaded'] for p,off,depth in pieces])
        images,masks=self.rasterizer.render(triangles[None],colors[None],self.rgb.shape[1],self.rgb.shape[0])
        image=images[0];mask=masks[0];self.rendered+=1;self.last_rgb=image;self.last_mask=mask
        metrics=balanced_color_metric(self.rgb,self.mask,image,mask,sorted(colors_allowed),
                                      {color:_rgb(color).tolist() for color in colors_allowed})
        iou=float((mask&self.mask).sum()/max(1,(mask|self.mask).sum()))
        evidence.update(metrics);evidence['silhouette_iou']=iou
        if renderpath:
            path=Path(renderpath);path.parent.mkdir(parents=True,exist_ok=True)
            cv2.imwrite(str(path),cv2.cvtColor(image,cv2.COLOR_RGB2BGR))
        return evidence


def selftest(out,plane_depth=False):
    import time
    from placement_part_library import PartLibrary
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    M=np.array([[1.,0.,-1.],[.5,1.,.5]])*1.7
    T=np.eye(4);T[:3,:3]=np.diag([-1.,1.,-1.]);items=[('3010pb291',1,T)]
    original=nativecolor_render(items,M,out/'legacy-target.png',resolver=PartLibrary().resolve)
    scorer=GpuColoredSceneScorer(dict(rgb=original['rgb'],mask=original['mask']),plane_depth=plane_depth)
    legacy_front=scorer.score(items,M,out/'gpu-target.png')
    generated_scene=dict(rgb=scorer.last_rgb.copy(),mask=scorer.last_mask.copy())
    reversed_pose=T.copy();reversed_pose[:3,:3]=np.eye(3)
    legacy_reverse=scorer.score([('3010pb291',1,reversed_pose)],M)
    scorer=GpuColoredSceneScorer(generated_scene,plane_depth=plane_depth)
    first=scorer.score(items,M,out/'gpu-front.png');image=scorer.last_rgb.copy();mask=scorer.last_mask.copy()
    repeat=scorer.score(items,M)
    exact=np.array_equal(image,scorer.last_rgb) and np.array_equal(mask,scorer.last_mask)
    G=np.array([[0.,0.,1.],[0.,1.,0.],[-1.,0.,0.]])
    rotated=[]
    for p,c,pose in items:
        changed=pose.copy();changed[:3,:3]=G@pose[:3,:3];changed[:3,3]=G@pose[:3,3];rotated.append((p,c,changed))
    gauge=scorer.score(rotated,M@G.T,out/'gpu-gauge.png')
    gauge_exact=np.array_equal(image,scorer.last_rgb) and np.array_equal(mask,scorer.last_mask)
    reverse=scorer.score([('3010pb291',1,reversed_pose)],M,out/'gpu-reverse.png')
    start=time.perf_counter()
    for _ in range(100):scorer.score(items,M)
    elapsed=time.perf_counter()-start
    result=dict(front=first,reverse=reverse,gauge=gauge,repeat_exact=exact,gauge_rgb_mask_exact=gauge_exact,
        printed_front_beats_reverse=first['score']>reverse['score'],renders=100,seconds=elapsed,
        peak_cuda_pool_bytes=scorer.rasterizer.cp.get_default_memory_pool().total_bytes(),
        legacy_cross_renderer=dict(front=legacy_front,reverse=legacy_reverse,
            note='Legacy centroid painter target differs in visible print coverage; preserved failed cross-renderer control.'),
        protocol='Universal printed brick GPU synthetic self-consistency controls; no set truth; not a real PDF pose benchmark')
    (out/'selftest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    assert exact and gauge_exact
    assert first['score']>reverse['score']


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--plane-depth',action='store_true');args=parser.parse_args()
    selftest(args.out,plane_depth=args.plane_depth)
