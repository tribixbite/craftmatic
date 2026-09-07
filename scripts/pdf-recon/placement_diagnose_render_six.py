"""Side-by-side triangle geometry comparison in one fixed runtime gauge."""
from pathlib import Path
import cv2
import numpy as np
from pose_score import read_parts
from placement_diagnose_pair_rank import to_items
from recon_v8.partrender import render,scene_fit

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis')
    selected=to_items(read_parts('output/pdf-placement-beam/40377-registered-six-v1/model.ldr'))
    truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')[:6])
    G=selected[0][2]@np.linalg.inv(next(p for p in truth if p[0]=='99780')[2])
    truth=[(p,c,G@T) for p,c,T in truth]
    fit=scene_fit(selected+truth,size=(500,420))
    render(selected,out/'registered-six-selected-triangles.png',size=(500,420),highlight_idx={4,5},fit=fit,draw_edges=False)
    render(truth,out/'registered-six-truth-triangles.png',size=(500,420),highlight_idx={3,4},fit=fit,draw_edges=False)
    views=[]
    for label,path in [('Selected: red parts misplaced','registered-six-selected-triangles.png'),('Reference: red parts missing','registered-six-truth-triangles.png')]:
        im=cv2.imread(str(out/path));cv2.putText(im,label,(10,20),cv2.FONT_HERSHEY_SIMPLEX,.55,(0,0,0),1);views.append(im)
    cv2.imwrite(str(out/'registered-six-triangle-comparison.png'),np.concatenate(views,axis=1))
