"""Necessary occupied-silhouette condition at one declared PDF registration.

Opaque occupancy union cannot erase pixels outside the completed target. The
claim applies only to the supplied native raster camera and mask tolerance;
camera uncertainty, PDF markings and hidden-line conventions remain external.
"""
import cv2
import numpy as np
from placement_cuda_layers import LayerRasterizer


def screen(base,placements,projection,origin,scorer,dilation_px=3,outside_tolerance_px=0):
    if dilation_px<0 or outside_tolerance_px<0:raise ValueError('Negative pixel tolerance')
    M=np.asarray(projection,float);origin=np.asarray(origin,float);raster=LayerRasterizer()
    allowed=cv2.dilate(scorer.mask.astype(np.uint8),np.ones((2*dilation_px+1,2*dilation_px+1),np.uint8))>0
    H,W=allowed.shape
    target=np.asarray(scorer.mask,bool);target_pixels=int(target.sum())
    def evidence(items):
        triangles=[]
        for p,c,T in items:
            T=np.asarray(T);d=scorer._project_part(p,c,T,M)
            xy=d['xy']+M@T[:3,3]+origin;z=d['vertex_depth']+d['camera']@T[:3,3]
            triangles.append(np.concatenate((xy,z[:,:,None]),2))
        tri=np.concatenate(triangles);low=np.floor(tri[:,:,:2].min((0,1))).astype(int)-1
        high=np.ceil(tri[:,:,:2].max((0,1))).astype(int)+1;size=high-low;tri[:,:,:2]-=low
        layer=raster.render_depth(tri[None],np.zeros((1,len(tri),3),np.uint8),int(size[0]),int(size[1]))
        ys,xs=np.nonzero(layer['mask'][0]);gx=xs+low[0];gy=ys+low[1];inside=(gx>=0)&(gy>=0)&(gx<W)&(gy<H)
        compatible=np.zeros(len(xs),bool);compatible[inside]=allowed[gy[inside],gx[inside]]
        outside=int((~compatible).sum())
        # Coverage of the undilated target is reported alongside containment
        # because containment alone cannot compare camera scales: a render that
        # is too small is trivially contained and explains nothing.
        covered=np.zeros((H,W),bool);covered[gy[inside],gx[inside]]=True
        return dict(occupied_pixels=len(xs),outside_pixels=outside,allowed=outside<=outside_tolerance_px,
            covered_pixels=int((covered&target).sum()),target_pixels=target_pixels,
            centroid=[float(gx.mean()),float(gy.mean())] if len(gx) else None)
    base_evidence=evidence(base)
    rows=[dict(index=i,**evidence(p['items'])) for i,p in enumerate(placements)] if base_evidence['allowed'] else []
    return dict(retained_indices=[r['index'] for r in rows if r['allowed']],candidates=rows,base=base_evidence,
        candidate_screen_skipped=not base_evidence['allowed'],input_candidates=len(placements),
        registration_consistent=base_evidence['allowed'],dilation_px=dilation_px,outside_tolerance_px=outside_tolerance_px,
        projection=M.tolist(),origin=origin.tolist(),truth_used=False,certified=False,
        protocol='Exact native raster occupied mask; no convex hull and no partial-state image-score pruning',
        limitations='Necessary condition only under specified registration and silhouette tolerance. Failing base occupancy invalidates this view rather than proving candidate failure. Does not establish collision, connectivity, or candidate recall.')
