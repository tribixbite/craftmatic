"""Resolution-normalized ellipse proposals; native physical projection retained."""
import cv2
import numpy as np
from placement_studs import detect_studs
from placement_camera import infer_camera_robust


def scale_camera_hypotheses(scene,scales=(1,2,3)):
    rows=[]
    value=np.repeat(scene['rgb'].max(2)[:,:,None],3,2)
    for scale in scales:
        rgb=cv2.resize(value,None,fx=scale,fy=scale,interpolation=cv2.INTER_CUBIC)
        mask=cv2.resize(scene['mask'].astype(np.uint8),None,fx=scale,fy=scale,interpolation=cv2.INTER_NEAREST)>0
        detections=detect_studs(rgb,mask)
        native=[dict(d,center=((np.asarray(d['center'])+.5)/scale-.5).tolist(),axes=(np.asarray(d['axes'])/scale).tolist()) for d in detections]
        camera=infer_camera_robust(native)
        rows.append(dict(scale=scale,detections=native,camera=camera,projection_units='native image pixels per LDU'))
    return dict(proposals=rows,hypotheses=[r for r in rows if r['camera'].get('ok')],
        warning='Interpolation changes contour sampling, not source information; hypotheses require geometric verification',truth_used=False)
