"""Approximate complete-pair screening with exact cached CAD depth layers.

No collision or truth checks. Fixed physical scale; each pair's target window
uses its own exact combined bounding-box center. Rendered pixels outside the
target image still contribute false positives, never disappear by cropping.
"""
import time
import cv2
import numpy as np
from placement_cuda_layers import LayerRasterizer
from placement_repeated_groups import compatible_pairs,projected_bounds
from placement_colored_cad import _rgb


SCORE_KERNEL=r'''
extern "C" __global__ void score_pairs(const unsigned int* depths,const unsigned char* labels,
 const int* pairs,const int* shifts,const unsigned char* target,const unsigned char* valid,
 const unsigned char* targetmask,const int* targetcounts,float* scores,
 int npairs,int pixels,int width,int tw,int th,int nc,int targetarea) {
 int pair=blockIdx.x, lane=threadIdx.x%32; if(pair>=npairs)return;
 int i=pairs[2*pair]+1,j=pairs[2*pair+1]+1;
 int sx=shifts[2*pair],sy=shifts[2*pair+1];
 int counts[16],intersections[16];
 for(int c=0;c<nc;c++){counts[c]=0;intersections[c]=0;}
 int area=0,overlap=0;
 for(int k=threadIdx.x;k<pixels;k+=blockDim.x){
   unsigned int best=depths[k];unsigned char label=labels[k];
   unsigned int a=depths[i*pixels+k],b=depths[j*pixels+k];
   if(a && a>=best){best=a;label=labels[i*pixels+k];}
   if(b && b>=best){best=b;label=labels[j*pixels+k];}
   if(!best)continue;area++;
   int tx=k%width-sx,ty=k/width-sy;
   bool inside=tx>=0&&tx<tw&&ty>=0&&ty<th;
   int ti=inside?ty*tw+tx:0;
   if(inside&&targetmask[ti])overlap++;
   if(inside&&!valid[ti])continue;
   if(label){counts[label-1]++;if(inside&&target[ti]==label)intersections[label-1]++;}
 }
 __shared__ int total_counts[16],total_intersections[16],total_area,total_overlap;
 if(threadIdx.x<nc){total_counts[threadIdx.x]=0;total_intersections[threadIdx.x]=0;}
 if(threadIdx.x==0){total_area=0;total_overlap=0;}__syncthreads();
 for(int c=0;c<nc;c++){
   int a=counts[c],b=intersections[c];
   for(int offset=16;offset;offset/=2){a+=__shfl_down_sync(0xffffffff,a,offset);b+=__shfl_down_sync(0xffffffff,b,offset);}
   if(lane==0){atomicAdd(total_counts+c,a);atomicAdd(total_intersections+c,b);}
 }
 for(int offset=16;offset;offset/=2){area+=__shfl_down_sync(0xffffffff,area,offset);overlap+=__shfl_down_sync(0xffffffff,overlap,offset);}
 if(lane==0){atomicAdd(&total_area,area);atomicAdd(&total_overlap,overlap);}__syncthreads();
 if(threadIdx.x==0){
   float color=0;int supported=0;
   for(int c=0;c<nc;c++)if(targetcounts[c]){supported++;color+=(float)total_intersections[c]/max(1,targetcounts[c]+total_counts[c]-total_intersections[c]);}
   float silhouette=(float)total_overlap/max(1,targetarea+total_area-total_overlap);
   scores[pair]=.8f*(supported?color/supported:0.f)+.2f*silhouette;
 }
}'''


def classify(rgb,mask,palette):
    hsv=cv2.cvtColor(np.asarray(rgb,np.uint8),cv2.COLOR_RGB2HSV).astype(float)
    ph=cv2.cvtColor(np.asarray(palette,np.uint8)[None],cv2.COLOR_RGB2HSV)[0].astype(float)
    h,s,v=hsv.transpose(2,0,1);chromatic=ph[:,1]>=65
    black=bool(np.any((ph[:,1]<65)&(ph[:,2]<85)))
    labels=np.zeros(mask.shape,np.uint8)
    for chroma in (True,False):
        choices=np.flatnonzero(chromatic==chroma)
        if not len(choices):continue
        difference=np.abs((h if chroma else v)[:,:,None]-ph[choices,0 if chroma else 2])
        if chroma:difference=np.minimum(difference,180-difference)
        nearest=np.argmin(difference,2)
        accepted=mask&((s>=65)&(difference.min(2)<=20) if chroma else (s<65)&((v>=85)|black))
        labels[accepted]=choices[nearest[accepted]]+1
    valid=np.ones(mask.shape,bool) if black else ~(mask&(s<65)&(v<85))
    return labels,valid


def shortlist_pairs(base,placements,projection,scorer,limit=256,copies=2):
    if limit<1:raise ValueError('limit must be positive')
    if copies not in (1,2):raise ValueError('Only one or two groups supported')
    started=time.perf_counter();M=np.asarray(projection,float)
    blo,bhi=projected_bounds(base,M,scorer)
    bounds=[projected_bounds(row['items'],M,scorer) for row in placements]
    if len(bounds)<copies:return [],dict(span_pairs=0,reason='Insufficient placements')
    lows=np.asarray([a for a,b in bounds]);highs=np.asarray([b for a,b in bounds])
    if copies==2:
        pairs=np.asarray(list(compatible_pairs(lows,highs,blo,bhi,scorer.target_span,scorer.span_tolerance)),np.int32).reshape(-1,2)
    else:
        errors=np.abs(np.maximum(highs,bhi)-np.minimum(lows,blo)-scorer.target_span)/scorer.target_span
        indices=np.flatnonzero(np.max(errors,axis=1)<=scorer.span_tolerance)
        pairs=np.column_stack((indices,np.full(len(indices),len(placements)))).astype(np.int32)
    if not len(pairs):return [],dict(span_pairs=0,reason='Exact physical span gate rejected all pairs')
    all_items=base+[item for row in placements for item in row['items']]
    colors=sorted(set(int(c) for p,c,T in all_items))
    if len(colors)>16:raise ValueError('Coarse GPU screen supports at most16 base colors')
    palette=np.stack([_rgb(c) for c in colors]).astype(np.uint8)
    material_colors=bool(getattr(scorer,'material_colors',False))
    glo=np.minimum(blo,lows.min(0));ghi=np.maximum(bhi,highs.max(0))
    scale=64./max(scorer.target_span)
    # Store only uint32 depth bits and uint8 color labels per cached pixel.
    # Shrink the declared coarse resolution rather than exceed the GPU budget.
    for _ in range(20):
        target_size=np.maximum(1,np.ceil(np.array(scorer.mask.shape[::-1])*scale).astype(int))
        padding=int(target_size.max())+3
        size=np.ceil((ghi-glo)*scale).astype(int)+2*padding+2
        bytes_needed=(len(placements)+1+(copies==1))*int(np.prod(size))*5
        if bytes_needed<=192*1024**2:break
        scale*=.8
    else:raise ValueError('Layer cache cannot fit declared memory budget')
    w,h=map(int,size);origin=np.array([padding,padding])-glo*scale
    raster=LayerRasterizer();cp=raster.cp
    # Camera direction does not change under uniform coarse image scaling.
    def triangles(items):
        ts=[];cs=[]
        for p,c,T in items:
            d=scorer._project_part(p,c,T,M)
            xy=(d['xy']+M@T[:3,3])*scale+origin
            z=d['vertex_depth']+d['camera']@T[:3,3]
            ts.append(np.concatenate((xy,z[:,:,None]),2))
            if material_colors:
                codes=scorer.geometry[(p,str(c))]['colors'];paint=np.zeros((len(codes),3),np.uint8)
                for index,color in enumerate(colors):paint[codes==color,0]=index+1
                cs.append(paint)
            else:cs.append(d['shaded'])
        return np.concatenate(ts),np.concatenate(cs)
    geometry=[triangles(base)]+[triangles(row['items']) for row in placements]
    depth_offset=1.-min(t[:,:,2].min() for t,c in geometry)
    layer_count=len(geometry)+(copies==1)
    depths=cp.zeros((layer_count,h,w),cp.uint32);labels=cp.zeros((layer_count,h,w),cp.uint8)
    for index,(t,c) in enumerate(geometry):
        layer=raster.render_depth(t[None],c[None],w,h,depth_offset=depth_offset,device=True)
        image=cp.asnumpy(layer['rgb'][0]);mask=cp.asnumpy(layer['mask'][0])
        if material_colors:lab=np.where(mask,image[:,:,0],0).astype(np.uint8)
        else:lab,_=classify(image,mask,palette)
        depths[index]=layer['depth_bits'][0];labels[index]=cp.asarray(lab)
    del layer,geometry
    affine=np.array([[scale,0.,0.],[0.,scale,0.]])
    rgb=cv2.warpAffine(scorer.rgb,affine,tuple(target_size),flags=cv2.INTER_NEAREST,borderValue=(245,245,245))
    targetmask=cv2.warpAffine(scorer.mask.astype(np.uint8),affine,tuple(target_size),flags=cv2.INTER_NEAREST)>0
    if material_colors:
        from placement_palette_classes import palette_labels
        target,valid=palette_labels(rgb,targetmask,palette)
    else:target,valid=classify(rgb,targetmask,palette)
    targetcounts=np.array([((target==i+1)&valid).sum() for i in range(len(colors))],np.int32)
    # Integer target-window shifts approximate subpixel resampling only; the
    # exact native combined bounds determine every individual alignment.
    if copies==2:
        pair_lo=np.minimum(np.minimum(lows[pairs[:,0]],lows[pairs[:,1]]),blo)
        pair_hi=np.maximum(np.maximum(highs[pairs[:,0]],highs[pairs[:,1]]),bhi)
    else:
        pair_lo=np.minimum(lows[pairs[:,0]],blo);pair_hi=np.maximum(highs[pairs[:,0]],bhi)
    native_origins=scorer.target_center-(pair_lo+pair_hi)/2
    shifts=np.round(origin-native_origins*scale).astype(np.int32)
    kernel=cp.RawKernel(SCORE_KERNEL,'score_pairs',options=('--std=c++11',))
    gt=cp.asarray(target);gv=cp.asarray(valid,np.uint8);gm=cp.asarray(targetmask,np.uint8);gc=cp.asarray(targetcounts)
    values=np.empty(len(pairs),np.float32)
    for start in range(0,len(pairs),256):
        part=pairs[start:start+256];shift=shifts[start:start+256];scores=cp.empty(len(part),cp.float32)
        kernel((len(part),),(256,),(depths,labels,cp.asarray(part),cp.asarray(shift),gt,gv,gm,gc,scores,
            np.int32(len(part)),np.int32(w*h),np.int32(w),np.int32(target_size[0]),np.int32(target_size[1]),
            np.int32(len(colors)),np.int32(targetmask.sum())))
        values[start:start+len(part)]=cp.asnumpy(scores)
    order=np.argsort(-values,kind='stable')[:limit]
    result=[(int(pairs[k,0]),int(pairs[k,1]),float(values[k])) for k in order]
    summary=dict(span_pairs=len(pairs),retained=len(result),cache_layers=layer_count,copies=copies,material_colors=material_colors,
        coarse_scale=scale,coarse_target_size=target_size.tolist(),canvas_size=[w,h],
        cache_bytes=bytes_needed,gpu_pool_reserved_bytes=cp.get_default_memory_pool().total_bytes(),
        seconds=time.perf_counter()-started,collision_checked=False,
        metric='0.8 target-supported macro color-region IoU +0.2 silhouette IoU; full canvas union',
        approximate=True,certified=False,truth_used=False,
        limitations=['Integer coarse target-window shifts lose subpixel precision.',
            'Finite shortlist can discard the best full-resolution candidate.',
            'Layer cache covers supplied independently legal placements, not all possible poses.'])
    return result,summary
