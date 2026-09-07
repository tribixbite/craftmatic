"""Joint search for two identical, independently attached PDF subassemblies.

No first-copy image ranking is used. The inexpensive span filter is exactly
the complete scorer's geometric filter. Both copies must mate to the existing
assembly; cross-copy-only attachments are outside this enumerator's scope.
"""
import heapq
import numpy as np


def compatible_pairs(lows, highs, base_lo, base_hi, target_span, tolerance):
    """Yield unordered distinct pairs passing the complete physical-span gate."""
    lows=np.asarray(lows);highs=np.asarray(highs)
    for i in range(len(lows)-1):
        lo=np.minimum(np.minimum(lows[i],lows[i+1:]),base_lo)
        hi=np.maximum(np.maximum(highs[i],highs[i+1:]),base_hi)
        errors=np.abs(hi-lo-target_span)/target_span
        for j in np.flatnonzero(np.max(errors,axis=1)<=tolerance):
            yield i,i+1+int(j)


def projected_bounds(items,projection,scorer):
    lows=[];highs=[]
    for part,color,T in items:
        value=scorer._project_part(part,color,T,projection)
        offset=projection@T[:3,3]
        lows.append(value['lo']+offset);highs.append(value['hi']+offset)
    return np.min(lows,axis=0),np.max(highs,axis=0)


def score_repeated_pair(base,placements,projections,scorer,make_assembly,solids,
                        group_source,keep=20,progress=None,coarse_limit=0,coarse_method='surface',checkpoint=None):
    """Exhaustive complete-pair scoring within declared connector candidates."""
    if keep<1:raise ValueError('keep must be positive')
    heap=[];serial=0;tested=0;span_pairs=0
    collision_cache={};assemblies={};screening=[]
    for view_index,projection in enumerate(projections):
        if coarse_limit:
            if coarse_method=='layers':
                from placement_layer_pair_screen import shortlist_pairs
            elif coarse_method=='surface':
                from placement_repeated_coarse import shortlist_pairs
            else:raise ValueError('Unknown complete-pair screening method')
            candidates,summary=shortlist_pairs(base,placements,projection,scorer,limit=coarse_limit)
            screening.append(dict(view=view_index,**summary))
            pairs=((i,j) for i,j,score in candidates)
        else:
            base_lo,base_hi=projected_bounds(base,projection,scorer)
            bounds=[projected_bounds(row['items'],projection,scorer) for row in placements]
            lows=[row[0] for row in bounds];highs=[row[1] for row in bounds]
            pairs=compatible_pairs(lows,highs,base_lo,base_hi,scorer.target_span,scorer.span_tolerance)
        for i,j in pairs:
            span_pairs+=1;key=(i,j)
            if key not in collision_cache:
                if i not in assemblies:
                    assemblies[i]=make_assembly(placements[i]['items'],solids)
                collision_cache[key]=any(assemblies[i].collides(solids.get(p,p),T)
                    for p,c,T in placements[j]['items'])
            if collision_cache[key]:continue
            items=base+placements[i]['items']+placements[j]['items']
            evidence=scorer.score(items,projection);tested+=1
            if evidence.get('bbox_rejected') or not np.isfinite(evidence['score']):continue
            row=dict(items=items,projection=projection,evidence=evidence,
                     group_source=group_source,
                     anchor_index=[placements[i]['anchor_index'],placements[j]['anchor_index']],
                     placement_indices=[i,j])
            entry=(float(evidence['score']),-serial,row);serial+=1
            if len(heap)<keep:heapq.heappush(heap,entry)
            elif entry[:2]>heap[0][:2]:heapq.heapreplace(heap,entry)
        status=dict(view=view_index+1,views=len(projections),
                    tested_views=tested,span_compatible_pairs=span_pairs)
        if checkpoint:
            current=[entry[2] for entry in sorted(heap,key=lambda entry:(-entry[0],-entry[1]))]
            checkpoint(current,status)
        if progress:progress(status)
    ranked=[entry[2] for entry in sorted(heap,key=lambda entry:(-entry[0],-entry[1]))]
    return ranked,dict(tested_views=tested,span_compatible_pairs=span_pairs,
                      collision_checked_pairs=len(collision_cache),
                      legal_pairs=sum(not value for value in collision_cache.values()),
                      coarse_limit=coarse_limit,coarse_method=coarse_method if coarse_limit else None,
                      screening=screening,exhaustive=not bool(coarse_limit))
