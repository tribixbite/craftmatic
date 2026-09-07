"""Fixed-physical-scale whole-assembly CAD/PDF color scoring.

Only translation aligns bounding-box centers. No rescaling, external model
truth, or VLM. Printed colors use authoritative universal part geometry.
"""
from collections import OrderedDict
from pathlib import Path
import cv2
import numpy as np
from placement_colored_cad import colored_triangles,_rgb
from placement_part_library import PartLibrary


class ColoredSceneScorer:
    def __init__(self,scene,resolver=None,span_tolerance=.35,max_projection_cache=4096):
        self.rgb=np.asarray(scene['rgb'],np.uint8);self.mask=np.asarray(scene['mask'],bool)
        yy,xx=np.nonzero(self.mask)
        if not len(xx):raise ValueError('Empty target component')
        self.target_lo=np.array([xx.min(),yy.min()],float)
        self.target_hi=np.array([xx.max(),yy.max()],float)
        self.target_span=np.maximum(1,self.target_hi-self.target_lo)
        self.target_center=(self.target_hi+self.target_lo)/2
        self.resolver=resolver or PartLibrary().resolve
        self.geometry={};self.projected=OrderedDict();self.cache_limit=max_projection_cache
        self.span_tolerance=span_tolerance;self.calls=0;self.rejected=0;self.rendered=0
        rgb=self.rgb.astype(float);self.chroma=rgb/np.maximum(1.,rgb.sum(axis=2,keepdims=True))
        r,g,b=rgb.transpose(2,0,1)
        self.target_yellow=(r>90)&(g>75)&(b<.7*np.minimum(r,g))&self.mask

    def _project_part(self,part,color,T,projection):
        T=np.asarray(T,float);projection=np.asarray(projection,float)
        gkey=(part,str(color))
        if gkey not in self.geometry:
            parsed=colored_triangles(part,color,resolver=self.resolver)
            self.geometry[gkey]=parsed
        key=(gkey,T[:3,:3].tobytes(),projection.tobytes())
        if key in self.projected:
            value=self.projected.pop(key);self.projected[key]=value;return value
        parsed=self.geometry[gkey];triangles=parsed['triangles']@T[:3,:3].T
        xy=triangles@projection.T
        camera=np.cross(projection[0],projection[1]);camera/=np.linalg.norm(camera)
        normals=np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0])
        normals/=np.maximum(1e-8,np.linalg.norm(normals,axis=1,keepdims=True))
        normals*=np.where(normals@camera>=0,1.,-1.)[:,None]
        light=np.array([.75,-1.,.15]);light/=np.linalg.norm(light)
        lit=np.maximum(0.,normals@light)
        rgb=np.stack([_rgb(code) for code in parsed['colors']])
        shaded=np.clip(rgb*(.42+.58*lit[:,None])+40*lit[:,None],0,255).astype(np.uint8)
        value=dict(xy=xy,lo=xy.reshape(-1,2).min(0),hi=xy.reshape(-1,2).max(0),
            depth=triangles.mean(axis=1)@camera,camera=camera,shaded=shaded)
        self.projected[key]=value
        if len(self.projected)>self.cache_limit:self.projected.popitem(last=False)
        return value

    def score(self,items,projection,renderpath=None):
        """Return evidence dict including score; render only after span gate."""
        self.calls+=1;projection=np.asarray(projection,float)
        pieces=[];lows=[];highs=[]
        for part,color,T in items:
            T=np.asarray(T,float);data=self._project_part(part,color,T,projection)
            offset=projection@T[:3,3]
            pieces.append((data,offset,float(data['camera']@T[:3,3])))
            lows.append(data['lo']+offset);highs.append(data['hi']+offset)
        if not pieces:raise ValueError('Empty assembly')
        lo=np.min(lows,axis=0);hi=np.max(highs,axis=0);span=hi-lo
        span_error=np.abs(span-self.target_span)/self.target_span
        origin=self.target_center-(lo+hi)/2
        evidence=dict(span_error=span_error.tolist(),projected_span=span.tolist(),
            target_span=self.target_span.tolist(),image_origin=origin.tolist(),rescaled=False,certified=False)
        if np.max(span_error)>self.span_tolerance:
            self.rejected+=1;evidence['rejected']='Physical projected span mismatch'
            evidence['score']=-1.;evidence['bbox_rejected']=True
            return evidence
        triangles=np.concatenate([p['xy']+off+origin for p,off,depth in pieces])
        depths=np.concatenate([p['depth']+depth for p,off,depth in pieces])
        colors=np.concatenate([p['shaded'] for p,off,depth in pieces])
        pixels=np.round(triangles).astype(np.int32)
        image=np.full(self.rgb.shape,245,np.uint8);mask=np.zeros(self.mask.shape,np.uint8)
        for index in np.argsort(depths,kind='stable'):
            cv2.fillConvexPoly(image,pixels[index],tuple(map(int,colors[index])))
            cv2.fillConvexPoly(mask,pixels[index],1)
        self.rendered+=1;predicted=mask>0;intersection=predicted&self.mask
        iou=float(intersection.sum()/max(1,(predicted|self.mask).sum()))
        rgb=image.astype(float);chroma=rgb/np.maximum(1.,rgb.sum(axis=2,keepdims=True))
        difference=np.linalg.norm(chroma-self.chroma,axis=2)
        chroma_match=difference<.13
        achromatic=np.ptp(chroma,axis=2)<.045
        chroma_match&=(~achromatic)|(np.ptp(self.chroma,axis=2)<.08)
        # White-vs-black must be checked separately from chroma similarity.
        light=rgb.mean(axis=2)>160;dark=rgb.mean(axis=2)<70
        brightness=(~light|(self.rgb.mean(axis=2)>110))&(~dark|(self.rgb.mean(axis=2)<130))
        compatible=chroma_match&brightness&intersection
        color_fraction=float(compatible.sum()/max(1,intersection.sum()))
        r,g,b=rgb.transpose(2,0,1)
        yellow=(r>90)&(g>75)&(b<.7*np.minimum(r,g))&predicted
        yellow_union=yellow|self.target_yellow
        yellow_iou=float((yellow&self.target_yellow).sum()/max(1,yellow_union.sum()))
        print_present=bool(yellow_union.any())
        weights=(.45,.35,.20) if print_present else (.55,.45,0)
        score=weights[0]*iou+weights[1]*color_fraction+weights[2]*yellow_iou
        evidence.update(silhouette_iou=iou,color_fraction=color_fraction,yellow_iou=yellow_iou,
            target_yellow_pixels=int(self.target_yellow.sum()),render_yellow_pixels=int(yellow.sum()),score=score)
        if renderpath:
            path=Path(renderpath);path.parent.mkdir(parents=True,exist_ok=True)
            cv2.imwrite(str(path),cv2.cvtColor(image,cv2.COLOR_RGB2BGR))
        return evidence

    def batchscore(self,assemblies,projections):
        """Yield assembly/view index and score without retaining every image."""
        for ai,items in enumerate(assemblies):
            for vi,projection in enumerate(projections):
                evidence=self.score(items,projection)
                yield ai,vi,evidence


def selftest(out):
    import json,time
    from placement_colored_cad import nativecolor_render
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    M=np.array([[1.,0,-1.],[.5,1.,.5]])*1.7
    T=np.eye(4);T[:3,:3]=np.diag([-1.,1.,-1.]);items=[('3010pb291',1,T)]
    rendered=nativecolor_render(items,M,out/'synthetic-source.png',resolver=PartLibrary().resolve)
    scorer=ColoredSceneScorer(dict(rgb=rendered['rgb'],mask=rendered['mask']))
    match=scorer.score(items,M,out/'matched.png');score=match['score']
    wrong=T.copy();wrong[:3,:3]=np.eye(3)
    bad=scorer.score([('3010pb291',1,wrong)],M,out/'wrong-view.png');other=bad['score']
    start=time.perf_counter()
    for _ in range(100):scorer.score(items,M)
    elapsed=time.perf_counter()-start
    result=dict(correct_score=score,wrong_face_score=other,correct=match,wrong=bad,
        repeated_renders=100,seconds=elapsed,projection_cache=len(scorer.projected),
        protocol='Universal printed brick synthetic face control; no set truth')
    (out/'selftest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    assert score>other
    assert match['yellow_iou']>.7


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);selftest(parser.parse_args().out)
