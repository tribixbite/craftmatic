"""Remove only connected antialias mixtures around already accepted arrows."""
from collections import Counter
import cv2,numpy as np
from placement_arrow_mask import hue_mask
from vector_scene import background_mask


def refine_arrow_halo(scene,graph,protected_colors=()):
    rgb=np.asarray(scene['rgb'],np.uint8);border=np.concatenate((rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]))
    background=np.asarray(Counter(map(tuple,border.tolist())).most_common(1)[0][0],float)
    accepted=np.asarray(graph['arrow_mask'],bool);halo=np.zeros(accepted.shape,bool);records=[]
    palette=np.asarray(list(protected_colors),np.uint8).reshape(-1,1,3)
    for hue in sorted(set(a['hue'] for a in graph['arrows'])):
        if len(palette) and hue_mask(palette,hue).any():
            records.append(dict(hue=hue,added=0,abstained='Actual CAD color conflicts with halo mixture hue'));continue
        core=accepted&hue_mask(rgb,hue)
        if not core.any():continue
        values=rgb[core].astype(float);strength=np.linalg.norm(values-background,axis=1)
        foreground=np.median(values[strength>=np.quantile(strength,.75)],axis=0);axis=foreground-background
        alpha=np.sum((rgb.astype(float)-background)*axis,axis=2)/max(1e-8,axis@axis)
        predicted=background+alpha[:,:,None]*axis
        residual=np.max(np.abs(rgb.astype(float)-predicted),axis=2)
        near=cv2.distanceTransform((~core).astype(np.uint8),cv2.DIST_L2,3)<=2.0
        proposal=near&(alpha>.015)&(alpha<.55)&(residual<=12)&~accepted
        # Require connectivity to a classified arrow, not arbitrary pale color.
        count,labels=cv2.connectedComponents((proposal|core).astype(np.uint8),8)
        ids=np.unique(labels[core]);ids=ids[ids!=0];proposal&=np.isin(labels,ids)
        halo|=proposal;records.append(dict(hue=hue,added=int(proposal.sum()),foreground_rgb=foreground.tolist(),background_rgb=background.tolist()))
    removed=accepted|halo;clean=rgb.copy();clean[removed]=background.astype(np.uint8)
    mask=background_mask(clean)&~removed
    n,labels,stats,_=cv2.connectedComponentsWithStats(mask.astype(np.uint8),8);components=[]
    for i in range(1,n):
        x,y,w,h,area=map(int,stats[i])
        if area>=12:components.append(dict(mask=labels==i,bbox=(x,y,x+w,y+h),area=area))
    components.sort(key=lambda c:-c['area'])
    return dict(graph,components=components,clean_mask=mask,arrow_mask=removed,halo_mask=halo,
        halo_evidence=dict(added_pixels=int(halo.sum()),records=records,method='<=2px connected fringe, alpha .015..55 background/accepted-arrow RGB mixture, residual<=12; protected hue conflicts abstain'))
