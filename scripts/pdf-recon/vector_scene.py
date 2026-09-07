"""PDF-native scene candidates, avoiding page text/PLI contamination.

scene_images(doc, page) returns a ranked list of dicts containing rgb (H,W,3
uint8), mask (H,W bool), bbox (PDF points), transform, xref, native_alpha,
inside_panel, near_quantity, red_arrow_fraction, and score. The first candidate
is a heuristic main assembly proposal; alternatives remain explicit. Masks
without native PDF alpha use border-connected background removal.
"""
import re
from collections import Counter

import cv2
import numpy as np
import pymupdf


def background_mask(rgb, tolerance=12):
    """Remove only background pixels connected to the image border."""
    border=np.concatenate((rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]))
    color=np.asarray(Counter(map(tuple,border.tolist())).most_common(1)[0][0])
    compatible=(np.max(np.abs(rgb.astype(np.int16)-color),axis=2)<=tolerance).astype(np.uint8)
    _,labels=cv2.connectedComponents(compatible,8)
    edge_ids=np.unique(np.concatenate((labels[0],labels[-1],labels[:,0],labels[:,-1])))
    edge_ids=edge_ids[edge_ids!=0]
    return ~np.isin(labels,edge_ids)


def scene_images(doc,page):
    words=page.get_text('words')
    quantities=[w for w in words if re.fullmatch(r'\d+x',w[4])]
    if sum(bool(re.fullmatch(r'\d{6,8}',w[4])) for w in words)>=5:
        return []
    panels=[]
    for drawing in page.get_drawings():
        box=drawing['rect']
        if (drawing.get('fill') is not None and 20<box.width<.92*page.rect.width
                and 20<box.height<.85*page.rect.height and box.get_area()>1500):
            panels.append(box)
    smasks={i[0]:i[1] for i in page.get_images(full=True)}
    candidates=[]
    for item in page.get_image_info(hashes=True,xrefs=True):
        bbox=pymupdf.Rect(item['bbox']);xref=item['xref']
        if (not xref or min(bbox.width,bbox.height)<25 or
                bbox.get_area()>.8*page.rect.get_area() or item['colorspace']!=3):
            continue
        near_qty=any(bbox.y1-3<=w[1]<=bbox.y1+15 and bbox.x0-10<=w[0]<=bbox.x1+10 for w in quantities)
        if near_qty:continue
        pix=pymupdf.Pixmap(doc,xref)
        if pix.colorspace!=pymupdf.csRGB:pix=pymupdf.Pixmap(pymupdf.csRGB,pix)
        rgb=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3].copy()
        alpha=False
        if smasks.get(xref):
            apix=pymupdf.Pixmap(doc,smasks[xref])
            amap=np.frombuffer(apix.samples,dtype=np.uint8).reshape(apix.height,apix.width,apix.n)[:,:,0]
            if amap.shape==rgb.shape[:2]:mask=amap>127;alpha=True
        if not alpha:mask=background_mask(rgb)
        inside=any(b.contains((bbox.tl+bbox.br)/2) for b in panels)
        r,g,b=rgb.transpose(2,0,1).astype(np.int16)
        red=(r>140)&(r>g+60)&(r>b+60)&mask
        score=bbox.get_area()*(.1 if inside else 1)
        candidates.append(dict(rgb=rgb,mask=mask,bbox=tuple(bbox),transform=item['transform'],
            xref=xref,native_alpha=alpha,inside_panel=inside,near_quantity=near_qty,
            red_arrow_fraction=float(red.sum()/max(1,mask.sum())),score=float(score)))
    return sorted(candidates,key=lambda x:-x['score'])


def scene_fragments(scene, arrow_color='red', min_area=12):
    """Diagnostic disconnected artwork after an explicitly selected arrow hue.

    Callers must establish that this hue is absent from the actual parts. This
    is not an automatic arrow detector. Returned components retain native-image
    coordinates and may still contain multiple touching parts.
    """
    rgb=scene['rgb'];r,g,b=rgb.transpose(2,0,1).astype(np.int16)
    if arrow_color=='red':colored=(r>120)&(r>g+45)&(r>b+45)
    elif arrow_color=='green':colored=(g>95)&(g>r+25)&(g>b+20)
    else:raise ValueError('arrow_color must be red or green')
    removed=cv2.dilate(colored.astype(np.uint8),np.ones((3,3),np.uint8))>0
    # Arrows can enclose a background island between two shafts. Recompute
    # border connectivity after opening the arrows, otherwise that island
    # spuriously bridges the detached part and main assembly.
    clean=rgb.copy()
    border=np.concatenate((rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]))
    background=Counter(map(tuple,border.tolist())).most_common(1)[0][0]
    clean[removed]=background
    foreground=(background_mask(clean)&~removed).astype(np.uint8)
    count,labels,stats,_=cv2.connectedComponentsWithStats(foreground,8)
    fragments=[]
    for k in range(1,count):
        x,y,w,h,area=map(int,stats[k])
        if area>=min_area:
            fragments.append(dict(mask=labels==k,bbox=(x,y,x+w,y+h),area=area))
    return sorted(fragments,key=lambda f:-f['area'])
