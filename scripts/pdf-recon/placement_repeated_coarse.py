"""Opt-in complete-pair shortlist from fixed-scale projected CAD samples.

Every unordered pair is scored together with the base under its own complete
bounds-center registration. This heuristic is not an upper bound or accuracy
certificate. It never ranks a first copy independently or reads model truth.
"""
import time
import numpy as np
from scipy.ndimage import distance_transform_edt


def _bundle(items,projection,scorer,per_part=12):
    points=[];lows=[];highs=[]
    for part,color,T in items:
        T=np.asarray(T,float);p=scorer._project_part(part,color,T,projection);offset=np.asarray(projection)@T[:3,3]
        xy=p['xy'].reshape(-1,2)
        # Deterministic stratified geometry samples; full extrema kept separately.
        indices=np.linspace(0,len(xy)-1,per_part).astype(int)
        points.append(xy[indices]+offset);lows.append(p['lo']+offset);highs.append(p['hi']+offset)
    return np.concatenate(points),np.min(lows,axis=0),np.max(highs,axis=0)


def shortlist_pairs(base,placements,projection,scorer,limit=256):
    if limit<=0:raise ValueError('Coarse shortlist is opt-in and requires positive limit')
    started=time.perf_counter();count=len(placements)
    if count<2:return [],dict(total_pairs=0,retained=0,heuristic=True)
    bp,blo,bhi=_bundle(base,projection,scorer)
    bundles=[_bundle(p['items'] if isinstance(p,dict) else p,projection,scorer) for p in placements]
    # A repeated group must have the same sampled point count in every placement.
    gp=np.stack([b[0] for b in bundles]);glo=np.stack([b[1] for b in bundles]);ghi=np.stack([b[2] for b in bundles])
    first,second=np.triu_indices(count,1);n=len(first);scores=np.full(n,-np.inf);origins=np.zeros((n,2));compatible=0
    target=np.asarray(scorer.mask,bool);height,width=target.shape;distance=distance_transform_edt(~target)
    targetspan=np.maximum(1,np.asarray(scorer.target_span));center=np.asarray(scorer.target_center)
    # Native pixel distance has physical meaning because camera scale is fixed.
    for start in range(0,n,2048):
        stop=min(n,start+2048);ii=first[start:stop];jj=second[start:stop]
        lo=np.minimum(np.minimum(glo[ii],glo[jj]),blo);hi=np.maximum(np.maximum(ghi[ii],ghi[jj]),bhi)
        span=hi-lo;error=np.abs(span-targetspan)/targetspan;origin=center-(lo+hi)/2;origins[start:stop]=origin
        legal=np.max(error,axis=1)<=scorer.span_tolerance;compatible+=int(legal.sum())
        if not legal.any():continue
        points=np.concatenate([np.broadcast_to(bp,(len(ii),*bp.shape)),gp[ii],gp[jj]],axis=1)+origin[:,None,:]
        rounded=np.rint(points).astype(int);x=rounded[:,:,0];y=rounded[:,:,1]
        inside=(x>=0)&(x<width)&(y>=0)&(y<height)
        distances=distance[np.clip(y,0,height-1),np.clip(x,0,width-1)]
        fitness=np.exp(-distances/3.)*inside
        # Equal base/copy/copy terms prevent the larger base dominating two copies.
        nb=len(bp);ng=gp.shape[1]
        fit=(fitness[:,:nb].mean(1)+fitness[:,nb:nb+ng].mean(1)+fitness[:,nb+ng:].mean(1))/3
        values=fit-.15*np.mean(error,axis=1);values[~legal]=-np.inf;scores[start:stop]=values
    # Diverse complete projected arrangements, retaining up to two tied pose
    # branches per coarse bounding-box cell. No truth-selected threshold.
    order=np.argsort(-scores,kind='stable');selected=[];seen={};cell=max(1.,max(targetspan)/48*2)
    for index in order:
        if not np.isfinite(scores[index]):break
        i,j=int(first[index]),int(second[index]);origin=origins[index]
        boxes=[tuple(np.rint(np.r_[glo[k]+origin,ghi[k]+origin]/cell).astype(int)) for k in (i,j)]
        key=tuple(sorted(boxes));seen[key]=seen.get(key,0)+1
        if seen[key]>2:continue
        selected.append((i,j,float(scores[index])))
        if len(selected)>=limit:break
    return selected,dict(total_pairs=n,bbox_compatible_pairs=compatible,retained=len(selected),limit=limit,
        diversity_cell_pixels=cell,branches_per_cell=2,seconds=time.perf_counter()-started,
        heuristic=True,truth_used=False,protocol='All unordered complete pairs; exact physical CAD bounds; fixed-scale shared registration; stratified occupied geometry samples; equal base/copy/copy distance fitness',
        limitations=['Heuristic shortlist can discard the correct complete pair','No visibility, color, collision or negative-occupancy proof; full renderer and collision checks required','Existing exhaustive search must remain available'])
