"""Conservatively mark chromatic future-state artwork absent current colors.

Uses universal LDraw palette hues and current emitted-part colors only. Dark
shading, black outlines and white foreground are not independently rejected.
This produces an unknown region, not evidence that the PDF part is absent.
"""
import sys
import cv2
import numpy as np


def unknown_regions(rgb, foreground, allowed_colors, palette=None):
    rgb=np.asarray(rgb,np.uint8);foreground=np.asarray(foreground,bool)
    if rgb.shape[:2]!=foreground.shape:raise ValueError('foreground shape differs from RGB')
    if not allowed_colors:
        return np.zeros(foreground.shape,bool),{'reason':'No current colors; do not reject image regions','unknown_pixels':0}
    if palette is None:
        sys.path.insert(0,'C:/git/clego')
        from recon_v7.render import color_rgb,COLOR_RGB
        missing=[int(c) for c in allowed_colors if int(c) not in COLOR_RGB]
        if missing:
            return np.zeros(foreground.shape,bool),{'reason':'Unmapped current color; do not reject scene hues','unmapped_ldraw_colors':missing,'unknown_pixels':0}
        palette={int(c):color_rgb(int(c)) for c in allowed_colors}
    allowed=np.array([palette[int(c)] for c in allowed_colors],np.uint8).reshape(-1,1,3)
    colors=cv2.cvtColor(allowed,cv2.COLOR_RGB2HSV)[:,0]
    chromatic=colors[(colors[:,1]>=65)&(colors[:,2]>=45),0].astype(float)
    hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
    foreign=foreground&(hsv[:,:,1]>=65)&(hsv[:,:,2]>=45)
    if len(chromatic):
        delta=np.abs(hsv[:,:,0,None].astype(float)-chromatic)
        near=np.minimum(delta,180-delta).min(axis=2)<=12
        foreign &= ~near
    # Ignore isolated compression/color-fringing pixels.
    count,labels,stats,_=cv2.connectedComponentsWithStats(foreign.astype(np.uint8),8)
    retained=np.zeros_like(foreign)
    for index in range(1,count):
        if stats[index,cv2.CC_STAT_AREA]>=4:retained |= labels==index
    contours,_=cv2.findContours(retained.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    filled=np.zeros_like(retained,np.uint8)
    cv2.drawContours(filled,contours,-1,1,cv2.FILLED)
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    dark_holes=(filled>0)&~retained&(gray<80)&foreground
    unknown=retained|dark_holes
    unknown=(cv2.dilate(unknown.astype(np.uint8),np.ones((3,3),np.uint8))>0)&foreground
    return unknown,{'method':'Absent chromatic palette hue; enclosed dark holes; one-pixel dilation',
                    'allowed_ldraw_colors':[int(c) for c in allowed_colors],
                    'foreign_color_pixels':int(retained.sum()),'enclosed_dark_pixels':int(dark_holes.sum()),
                    'unknown_pixels':int(unknown.sum()),'foreground_pixels':int(foreground.sum()),
                    'unknown_fraction':float(unknown.sum()/max(1,foreground.sum())),
                    'limitations':['Conservative hue matching; printed patterns or lighting can disagree','Achromatic future parts cannot be isolated by this method','Unknown does not certify absence or part identity']}


def filter_unknown_studs(detections, unknown):
    unknown=np.asarray(unknown,bool);kept=[];rejected=[]
    for index,p in enumerate(detections):
        x,y=np.rint(p['center']).astype(int)
        if 0<=y<unknown.shape[0] and 0<=x<unknown.shape[1] and unknown[y,x]:rejected.append(index)
        else:kept.append(p)
    return kept,{'excluded_detection_indices':rejected,'retained':len(kept)}
