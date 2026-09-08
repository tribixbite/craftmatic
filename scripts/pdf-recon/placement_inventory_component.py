"""Quantity-anchored isolation inside a PDF inventory's coarse icon box."""
import cv2
import numpy as np


def refine(rgb,anchor):
    rgb=np.asarray(rgb,np.uint8);anchor=np.asarray(anchor,float)
    border=np.concatenate((rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]))
    colors,counts=np.unique(border,axis=0,return_counts=True);background=colors[np.argmax(counts)]
    mask=(np.max(np.abs(rgb.astype(float)-background),axis=2)>24).astype(np.uint8)
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    n,labels,stats,_=cv2.connectedComponentsWithStats(mask,8);options=[]
    for i in range(1,n):
        x,y,w,h,area=map(int,stats[i])
        if area<12 or min(w,h)<3:continue
        ys,xs=np.nonzero(labels==i);above=ys<=anchor[1]+2
        if not above.any():continue
        distance=float(np.sqrt(np.min((xs[above]-anchor[0])**2+(ys[above]-anchor[1])**2)))
        options.append(dict(component=i,bbox=[x,y,x+w,y+h],area=area,distance=distance))
    options.sort(key=lambda r:r['distance'])
    report=dict(background=background.tolist(),anchor=anchor.tolist(),components=options,refined=False,
        protocol='Nearest connected native artwork above its printed quantity; ambiguous associations abstain')
    if len(options)<2:return rgb,report
    if options[0]['distance']>max(24,2*anchor[2]) or options[1]['distance']-options[0]['distance']<3:
        report['reason']='Quantity/component association uncertain';return rgb,report
    box=np.array(options[0]['bbox']);selected={options[0]['component']}
    # Preserve enclosed islands and near-touching pieces of the same drawing.
    changed=True
    while changed:
        changed=False
        for row in options:
            if row['component'] in selected:continue
            b=np.array(row['bbox'])
            if np.all(b[:2]<=box[2:]+2) and np.all(b[2:]>=box[:2]-2):
                box[:2]=np.minimum(box[:2],b[:2]);box[2:]=np.maximum(box[2:],b[2:]);selected.add(row['component']);changed=True
    box[:2]=np.maximum(0,box[:2]-2);box[2:]=np.minimum(rgb.shape[1::-1],box[2:]+2)
    report.update(refined=True,bbox=box.tolist(),retained_components=sorted(selected))
    return rgb[box[1]:box[3],box[0]:box[2]].copy(),report
