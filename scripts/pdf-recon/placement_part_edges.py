"""Opt-in real-geometry orientation matching against native PDF components.

Universal LDraw geometry only; no model truth, learned weights or VLM. Scores
are appearance hypotheses, not calibrated pose confidence. Calls are serial:
the legacy renderer's projection globals are temporarily changed and restored.
"""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import sys

import cv2
import numpy as np
sys.path.insert(0,'C:/git/clego')
from recon_v8 import partrender
from vector_scene import background_mask

PROJECTION=np.array([[1.,0.,-1.],[.5,1.,.5]])
SIZE=128


def canonical(rgb,mask):
    yy,xx=np.nonzero(mask)
    if len(xx)<10:raise ValueError('Insufficient component foreground')
    rgb=rgb[yy.min():yy.max()+1,xx.min():xx.max()+1].copy()
    mask=mask[yy.min():yy.max()+1,xx.min():xx.max()+1]
    rgb[~mask]=245
    h,w=mask.shape;scale=(SIZE-12)/max(h,w)
    shape=(max(1,round(w*scale)),max(1,round(h*scale)))
    image=np.full((SIZE,SIZE,3),245,np.uint8);target=np.zeros((SIZE,SIZE),np.uint8)
    x=(SIZE-shape[0])//2;y=(SIZE-shape[1])//2
    image[y:y+shape[1],x:x+shape[0]]=cv2.resize(rgb,shape,interpolation=cv2.INTER_AREA)
    target[y:y+shape[1],x:x+shape[0]]=cv2.resize(mask.astype(np.uint8),shape,interpolation=cv2.INTER_NEAREST)
    return image,target


def features(rgb,mask):
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    gray=cv2.GaussianBlur(gray,(3,3),.6)
    edges=cv2.Canny(gray,35,85)>0
    interior=cv2.erode(mask,np.ones((3,3),np.uint8))>0
    internal=edges&interior
    boundary=cv2.morphologyEx(mask,cv2.MORPH_GRADIENT,np.ones((3,3),np.uint8))>0
    return dict(mask=mask>0,edges=edges,internal=internal,boundary=boundary)


def chamfer(first,second):
    if not first.any() or not second.any():return 0.
    a=cv2.distanceTransform((~first).astype(np.uint8),cv2.DIST_L2,3)
    b=cv2.distanceTransform((~second).astype(np.uint8),cv2.DIST_L2,3)
    distance=(float(a[second].mean())+float(b[first].mean()))/2
    return float(np.exp(-distance/4.))


def compare(a,b):
    iou=float((a['mask']&b['mask']).sum()/max(1,(a['mask']|b['mask']).sum()))
    internal=chamfer(a['internal'],b['internal'])
    all_edges=chamfer(a['edges'],b['edges'])
    return .2*iou+.4*internal+.4*all_edges,dict(iou=iou,internal=internal,all_edges=all_edges)


def render_rotations(part,color,rotations,outcache,projection=None):
    outcache=Path(outcache);outcache.mkdir(parents=True,exist_ok=True)
    # Reject the renderer's silent cuboid fallback. Missing real geometry must
    # never provide false orientation evidence.
    path=partrender._find_dat(str(part).removesuffix('.dat')+'.dat')
    if not path or not partrender._parse_dat(path):raise ValueError(f'No real LDraw triangle geometry: {part}')
    geometry=partrender.part_tris(part)
    projection=PROJECTION if projection is None else np.asarray(projection,float)
    common=hashlib.sha256(geometry.tobytes()+projection.tobytes()+Path(__file__).read_bytes()).hexdigest()
    old_proj=partrender.PROJ;old_cam=partrender.CAM
    camera=np.cross(projection[0],projection[1]);camera/=np.linalg.norm(camera)
    outputs=[]
    try:
        partrender.PROJ=projection.copy();partrender.CAM=camera
        for rotation in rotations:
            transform=np.eye(4);transform[:3,:3]=np.asarray(rotation)[:3,:3]
            key=hashlib.sha256((common+str(color)).encode()+transform.tobytes()).hexdigest()[:24]
            output=outcache/f'{part}-{color}-{key}.png'
            if not output.exists():
                partrender.render([(part,color,transform)],output,size=(240,240),draw_edges=False,min_area=.08)
            rgb=cv2.cvtColor(cv2.imread(str(output)),cv2.COLOR_BGR2RGB)
            # Synthetic background is exactly 245. PDF's tolerance12 would
            # classify lit white255 surfaces as background (difference10),
            # deleting entire part faces and corrupting orientation scores.
            outputs.append(canonical(rgb,background_mask(rgb,tolerance=0)))
    finally:
        partrender.PROJ=old_proj;partrender.CAM=old_cam
    return outputs


def part_orientation_scores(part,color,rotations,scene,component,outcache,projection=None):
    """Return ndarray[len(rotations)], higher better; score range [0,1]."""
    image,mask=canonical(scene['rgb'],component['mask'])
    target=features(image,mask)
    renders=render_rotations(part,color,rotations,outcache,projection=projection)
    return np.asarray([compare(target,features(rgb,m))[0] for rgb,m in renders])


def cube_rotations():
    rotations=[]
    for perm in itertools.permutations(range(3)):
        for sign in itertools.product((-1,1),repeat=3):
            r=np.eye(3)[:,perm]*np.asarray(sign)
            if np.linalg.det(r)>.5:
                t=np.eye(4);t[:3,:3]=r;rotations.append(t)
    return rotations


def selftest(out):
    out.mkdir(parents=True,exist_ok=True);rotations=cube_rotations();records=[]
    sample=np.full((20,20,3),245,np.uint8);sample[5:15,5:15]=255
    assert background_mask(sample,tolerance=0)[10,10]
    assert not background_mask(sample,tolerance=0)[0,0]
    original=partrender.PROJ.copy()
    for part,color,index in [('3001',4,5),('2420',15,9),('15571',15,17)]:
        renders=render_rotations(part,color,rotations,out/'cache')
        # Synthetic held transform; input image downsampled and brightened so
        # this is not exact cached-pixel equality. No set or model is involved.
        rgb,mask=renders[index]
        small=cv2.resize(rgb,(80,80),interpolation=cv2.INTER_AREA)
        small=np.clip(small.astype(float)*.92+8,0,255).astype(np.uint8)
        smask=cv2.resize(mask,(80,80),interpolation=cv2.INTER_NEAREST)>0
        scores=part_orientation_scores(part,color,rotations,dict(rgb=small),dict(mask=smask),out/'cache')
        rank=int(np.sum(scores>scores[index]+1e-8))+1
        records.append(dict(part=part,color=color,known_rotation=index,rank=rank,
                            best_rotation=int(np.argmax(scores)),scores=scores.tolist()))
        cv2.imwrite(str(out/f'{part}-synthetic.png'),cv2.cvtColor(small,cv2.COLOR_RGB2BGR))
    restored=bool(np.array_equal(original,partrender.PROJ))
    result=dict(protocol='Synthetic part rotations only; no set truth or tuning.',
                projection_restored=restored,records=records)
    (out/'selftest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    assert restored
    assert all(r['rank']==1 for r in records),records


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--selftest',type=Path,required=True)
    selftest(parser.parse_args().selftest)
