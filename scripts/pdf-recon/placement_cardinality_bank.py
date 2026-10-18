"""GPU-rendered, CPU-resident material/depth bank at one fixed PDF registration.

Does not generate or prune poses. Complete canvas retains out-of-target false
positives. Caller must provide native projection and origin from PDF evidence.
"""
import numpy as np
from placement_cuda_layers import LayerRasterizer
from placement_colored_cad import _rgb
from placement_palette_classes import palette_labels


def build_bank(base,candidates,projection,origin,scorer,scale=1.,max_host_bytes=512*1024**2):
    M=np.asarray(projection,float);origin=np.asarray(origin,float)
    if scale<=0:raise ValueError('Scale must be positive')
    groups=[base]+[row['items'] for row in candidates]
    colors=sorted(set(int(c) for items in groups for p,c,T in items))
    if len(colors)>255:raise ValueError('Material label budget exceeded')
    geometry=[]
    for items in groups:
        triangles=[];paints=[]
        for part,color,T in items:
            T=np.asarray(T,float);data=scorer._project_part(part,color,T,M)
            xy=(data['xy']+M@T[:3,3]+origin)*scale
            depth=data['vertex_depth']+data['camera']@T[:3,3]
            triangles.append(np.concatenate((xy,depth[:,:,None]),2))
            codes=scorer.geometry[(part,str(color))]['colors'];paint=np.zeros((len(codes),3),np.uint8)
            for index,code in enumerate(colors):paint[codes==code,0]=index+1
            paints.append(paint)
        geometry.append((np.concatenate(triangles),np.concatenate(paints)))
    xy=np.concatenate([tri[:,:,:2].reshape(-1,2) for tri,_ in geometry])
    low=np.minimum(np.floor(xy.min(0))-2,[0,0]).astype(int)
    high=np.maximum(np.ceil(xy.max(0))+2,np.ceil(np.array(scorer.mask.shape[::-1])*scale)).astype(int)
    width,height=map(int,high-low);required=len(groups)*width*height*5
    if required>max_host_bytes:raise ValueError(f'Bank requires {required} bytes; choose explicit coarser scale or larger host budget')
    import cv2
    affine=np.array([[scale,0.,-low[0]],[0.,scale,-low[1]]])
    rgb=cv2.warpAffine(scorer.rgb,affine,(width,height),flags=cv2.INTER_NEAREST,borderValue=(245,245,245))
    mask=cv2.warpAffine(scorer.mask.astype(np.uint8),affine,(width,height),flags=cv2.INTER_NEAREST)>0
    target,valid=palette_labels(rgb,mask,np.stack([_rgb(c) for c in colors]).astype(np.uint8))
    target[~valid]=0
    raster=LayerRasterizer();depths=np.empty((len(groups),height,width),np.float32);labels=np.empty((len(groups),height,width),np.uint8)
    depth_offset=1.-min(tri[:,:,2].min() for tri,_ in geometry)
    for index,(tri,paint) in enumerate(geometry):
        tri=tri.copy();tri[:,:,:2]-=low
        layer=raster.render_depth(tri[None],paint[None],width,height,depth_offset=depth_offset)
        depths[index]=layer['depth'][0];labels[index]=np.where(layer['mask'][0],layer['rgb'][0,:,:,0],0)
        labels[index,~valid]=0
    return dict(base_depth=depths[0],base_labels=labels[0],depths=depths[1:],labels=labels[1:],target=target,
        metadata=dict(colors=colors,projection=M.tolist(),origin=origin.tolist(),scale=scale,canvas_low=low.tolist(),
        canvas_size=[width,height],host_bank_bytes=required,truth_used=False,certified=False,
        limitations='Fixed registration only; rasterized finite candidate bank. Coarse scale is explicit; no camera, support-closure, collision, or full pose-recall guarantee.'))
