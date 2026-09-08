"""Synthetic projected-cap calibration under low-resolution sampling."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from placement_native_scale_camera import scale_camera_hypotheses
from placement_beam import rotations


def run(out):
    out.mkdir(parents=True,exist_ok=True)
    M=np.array([[.65,0,-.92],[.53,.92,.375]])
    covariance=M[:,[0,2]]@M[:,[0,2]].T*36
    values,vectors=np.linalg.eigh(covariance);direction=vectors[:,1];angle=float(np.degrees(np.arctan2(direction[1],direction[0])))
    rgb=np.full((120*4,130*4,3),(211,237,252),np.uint8);mask=np.zeros(rgb.shape[:2],np.uint8)
    for x in (-30,-10,10,30):
        for z in (-30,-10,10,30):
            center=(M@np.array([x,0,z])+[65,55])*4;axes=np.sqrt(values[::-1])*4
            cv2.ellipse(rgb,tuple(np.rint(center).astype(int)),tuple(np.rint(axes).astype(int)),angle,0,360,(180,10,20),-1)
            cv2.ellipse(rgb,tuple(np.rint(center).astype(int)),tuple(np.rint(axes).astype(int)),angle,0,360,(15,15,15),3)
            cv2.ellipse(mask,tuple(np.rint(center).astype(int)),tuple(np.rint(axes+2).astype(int)),angle,0,360,1,-1)
    rgb=cv2.resize(rgb,(130,120),interpolation=cv2.INTER_AREA);mask=cv2.resize(mask,(130,120),interpolation=cv2.INTER_NEAREST)>0
    result=scale_camera_hypotheses(dict(rgb=rgb,mask=mask));rows=[]
    for proposal in result['hypotheses']:
        inferred=np.asarray(proposal['camera']['matrix']);error=min(np.linalg.norm(inferred-M@R[:3,:3])/np.linalg.norm(M) for R in rotations())
        rows.append(dict(scale=proposal['scale'],relative_camera_error=float(error),inliers=proposal['camera']['inlier_count']))
    assert rows and min(r['relative_camera_error'] for r in rows)<.10
    (out/'results.json').write_text(json.dumps(dict(planted_projection=M.tolist(),results=rows,truth_used=False,
        scope='Synthetic universal projected cap grid only, not a set reference',proposals=result),indent=2))
    cv2.imwrite(str(out/'synthetic.png'),cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR));print(json.dumps(rows))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);run(p.parse_args().out)
