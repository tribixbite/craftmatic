"""Lighting controls and native PDF color evidence; no model pose inputs."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
import pymupdf
from placement_color_likelihood import color_likelihood
from placement_colored_cad import _rgb
from placement_palette_classes import palette_labels
from vector_scene import scene_images


def run(out):
    out.mkdir(parents=True,exist_ok=True);colors=[14,19,29,71,15,322];palette=np.asarray([_rgb(c) for c in colors],np.uint8)
    controls=[]
    # Held-out lighting values deliberately differ from the helper's bank.
    for gain in (.37,.56,.78,1.02):
        for ambient in (9,31,53):
            pixels=np.clip(gain*palette.astype(float)+ambient,0,255).astype(np.uint8)[None]
            evidence=color_likelihood(pixels,np.ones(pixels.shape[:2],bool),palette)
            for i,c in enumerate(colors):
                p=float(evidence['probability'][0,i,i]);winner=colors[int(evidence['labels'][0,i])-1]
                # The generating material must remain plausible even where
                # competing neutral/material lighting models are ambiguous.
                assert p>=.12
                controls.append(dict(color=c,gain=gain,ambient=ambient,true_probability=p,winner=winner,ambiguous=bool(evidence['ambiguous'][0,i])))
    exact=color_likelihood(palette[None],np.ones((1,len(colors)),bool),palette)
    assert exact['labels'].tolist()==[[1,2,3,4,5,6]]
    black=color_likelihood(np.zeros((1,1,3),np.uint8),np.ones((1,1),bool),palette);assert not black['valid'][0,0]
    # New observations only; exact pixel regions below are generic connected
    # yellow-family masks, not hand-selected part locations.
    codes=[0,1,4,14,15,19,71];pal=np.asarray([_rgb(c) for c in codes],np.uint8)
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:
        scene=next(s for s in scene_images(doc,doc[12]) if s['xref']==120)
    new=color_likelihood(scene['rgb'],scene['mask'],pal);old,_=palette_labels(scene['rgb'],scene['mask'],pal)
    hsv=cv2.cvtColor(scene['rgb'],cv2.COLOR_RGB2HSV);family=scene['mask']&(hsv[:,:,0]>=15)&(hsv[:,:,0]<=40)&(hsv[:,:,1]>=35)&(hsv[:,:,2]>=85)
    n,cc,stats,centers=cv2.connectedComponentsWithStats(family.astype(np.uint8),8);regions=[]
    for j in range(1,n):
        if stats[j,4]<50:continue
        region=cc==j
        regions.append(dict(area=int(region.sum()),bbox=stats[j,:4].tolist(),center=centers[j].tolist(),
            old_counts={str(c):int(((old==i+1)&region).sum()) for i,c in enumerate(codes)},
            new_counts={str(c):int(((new['labels']==i+1)&region).sum()) for i,c in enumerate(codes)},
            mean_likelihood={str(c):float(new['probability'][:,:,i][region].mean()) for i,c in enumerate(codes)},
            ambiguous=int((new['ambiguous']&region).sum())))
    regions.sort(key=lambda r:-r['area'])
    visualization=np.full_like(scene['rgb'],245)
    for i,c in enumerate(codes):visualization[new['labels']==i+1]=_rgb(c)
    cv2.imwrite(str(out/'native-labels.png'),cv2.cvtColor(visualization,cv2.COLOR_RGB2BGR))
    result=dict(controls=controls,exact_palette_labels=exact['labels'].tolist(),dark_unknown=True,native_regions=regions,
        protocol=new['protocol'],truth_used=False,runtime_vlm_calls=0,baseline_unchanged=True,
        limitations=['Color likelihood is not a segmentation or part identity certificate.','Neutral colors under lighting remain ambiguous.','Printed colors must be explicit in caller palette.'])
    (out/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(dict(controls=len(controls),native_regions=regions[:5])))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);run(p.parse_args().out)
