"""Complete repeated-pair plus singleton layer search; no greedy pose ranking."""
import time
import cv2
import numpy as np
from placement_layer_pair_screen import SCORE_KERNEL,classify
from placement_cuda_layers import LayerRasterizer
from placement_repeated_groups import projected_bounds
from placement_colored_cad import _rgb


TRIPLE_KERNEL=SCORE_KERNEL.replace('int i=pairs[2*pair]+1,j=pairs[2*pair+1]+1;',
    'int i=pairs[3*pair]+1,j=pairs[3*pair+1]+1,q=pairs[3*pair+2]+1;').replace(
    'if(b && b>=best){best=b;label=labels[j*pixels+k];}',
    'if(b && b>=best){best=b;label=labels[j*pixels+k];} unsigned int d=depths[q*pixels+k]; if(d && d>=best){best=d;label=labels[q*pixels+k];}')


def shortlist_triples(base,repeated,singletons,projection,scorer,limit=512):
    start=time.perf_counter();M=np.asarray(projection,float);placements=repeated+singletons;n=len(repeated)
    if n<2 or not singletons:return [],dict(reason='Not enough connector candidates')
    blo,bhi=projected_bounds(base,M,scorer)
    bounds=[projected_bounds(row['items'],M,scorer) for row in placements]
    lows=np.array([lo for lo,hi in bounds]);highs=np.array([hi for lo,hi in bounds])
    ii,jj=np.triu_indices(n,1);pair_lo=np.minimum(np.minimum(lows[ii],lows[jj]),blo)
    pair_hi=np.maximum(np.maximum(highs[ii],highs[jj]),bhi)
    triples=[];centers=[]
    for k in range(n,len(placements)):
        lo=np.minimum(pair_lo,lows[k]);hi=np.maximum(pair_hi,highs[k]);span=hi-lo
        good=np.max(abs(span-scorer.target_span)/scorer.target_span,axis=1)<=scorer.span_tolerance
        triples.append(np.column_stack((ii[good],jj[good],np.full(good.sum(),k,int))))
        centers.append((lo[good]+hi[good])/2)
    triples=np.concatenate(triples).astype(np.int32);centers=np.concatenate(centers)
    if not len(triples):return [],dict(reason='No full triple passes physical span gate')
    items=base+[item for row in placements for item in row['items']]
    colors=sorted(set(int(c) for p,c,T in items));palette=np.stack([_rgb(c) for c in colors]).astype(np.uint8)
    if len(colors)>16:raise ValueError('At most16 coarse colors supported')
    lo=np.minimum(blo,lows.min(0));hi=np.maximum(bhi,highs.max(0));scale=64/max(scorer.target_span)
    for _ in range(20):
        size_target=np.maximum(1,np.ceil(np.array(scorer.mask.shape[::-1])*scale).astype(int));pad=int(size_target.max())+3
        size=np.ceil((hi-lo)*scale).astype(int)+2*pad+2;bytes_=(len(placements)+1)*int(np.prod(size))*5
        if bytes_<=192*1024**2:break
        scale*=.8
    else:raise ValueError('Layer cache too large')
    origin=np.array([pad,pad])-lo*scale;w,h=map(int,size);raster=LayerRasterizer();cp=raster.cp
    def geometry(items):
        ts=[];cs=[]
        for p,c,T in items:
            d=scorer._project_part(p,c,T,M);xy=(d['xy']+M@T[:3,3])*scale+origin
            z=d['vertex_depth']+d['camera']@T[:3,3]
            ts.append(np.concatenate((xy,z[:,:,None]),2));cs.append(d['shaded'])
        return np.concatenate(ts),np.concatenate(cs)
    geometries=[geometry(base)]+[geometry(row['items']) for row in placements]
    offset=1-min(t[:,:,2].min() for t,c in geometries)
    depths=cp.empty((len(geometries),h,w),cp.uint32);labels=cp.empty((len(geometries),h,w),cp.uint8)
    for index,(t,c) in enumerate(geometries):
        layer=raster.render_depth(t[None],c[None],w,h,depth_offset=offset,device=True)
        rgb=cp.asnumpy(layer['rgb'][0]);mask=cp.asnumpy(layer['mask'][0]);lab,_=classify(rgb,mask,palette)
        depths[index]=layer['depth_bits'][0];labels[index]=cp.asarray(lab)
    del geometries,layer
    affine=np.array([[scale,0,0],[0,scale,0]])
    rgb=cv2.warpAffine(scorer.rgb,affine,tuple(size_target),flags=cv2.INTER_NEAREST,borderValue=(245,245,245))
    mask=cv2.warpAffine(scorer.mask.astype(np.uint8),affine,tuple(size_target),flags=cv2.INTER_NEAREST)>0
    target,valid=classify(rgb,mask,palette);counts=np.array([((target==i+1)&valid).sum() for i in range(len(colors))],np.int32)
    shifts=np.round(origin-(scorer.target_center-centers)*scale).astype(np.int32)
    kernel=cp.RawKernel(TRIPLE_KERNEL,'score_pairs',options=('--std=c++11',));values=np.empty(len(triples),np.float32)
    gt=cp.asarray(target);gv=cp.asarray(valid,np.uint8);gm=cp.asarray(mask,np.uint8);gc=cp.asarray(counts)
    for start_index in range(0,len(triples),256):
        rows=triples[start_index:start_index+256];scores=cp.empty(len(rows),cp.float32)
        kernel((len(rows),),(256,),(depths,labels,cp.asarray(rows),cp.asarray(shifts[start_index:start_index+256]),gt,gv,gm,gc,scores,
            np.int32(len(rows)),np.int32(w*h),np.int32(w),np.int32(size_target[0]),np.int32(size_target[1]),np.int32(len(colors)),np.int32(mask.sum())))
        values[start_index:start_index+len(rows)]=cp.asnumpy(scores)
    order=np.argsort(-values,kind='stable')[:limit]
    rows=[(int(triples[k,0]),int(triples[k,1]),int(triples[k,2]-n),float(values[k])) for k in order]
    return rows,dict(span_triples=len(triples),retained=len(rows),seconds=time.perf_counter()-start,
        cache_bytes=bytes_,gpu_pool_reserved_bytes=cp.get_default_memory_pool().total_bytes(),canvas_size=[w,h],
        coarse_scale=scale,approximate=True,collision_checked=False,truth_used=False,
        metric='0.8 macro color IoU +0.2 silhouette; complete triple, entire canvas union')
