"""Fixed-scale PDF image registration for a known part and orientation.

No truth models, learned models, or VLM. Returned offsets are hypotheses:
image_xy = projection @ world_xyz + image_origin. Rendering keeps exact
projected geometry offsets; no bounding-box-center reconstruction is used.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import cv2
import numpy as np
sys.path.insert(0,'C:/git/clego')
from recon_v8 import partrender
from vector_scene import background_mask,scene_images
from vector_scene_components import component_graph
from placement_pdf_camera import camera_for


def native_template(part,color,T,projection,out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    projection=np.asarray(projection,float);T=np.asarray(T,float)
    path=partrender._find_dat(str(part).removesuffix('.dat')+'.dat')
    if not path or not partrender._parse_dat(path):raise ValueError('Actual part geometry unavailable')
    triangles=partrender.part_tris(part)
    world=triangles.reshape(-1,3)@T[:3,:3].T+T[:3,3]
    projected=world@projection.T
    lo=projected.min(0);hi=projected.max(0)
    offset=np.array([4.,4.])-lo
    size=np.ceil(hi-lo+9).astype(int)
    key=hashlib.sha256(triangles.tobytes()+T.tobytes()+projection.tobytes()+str(color).encode()+Path(__file__).read_bytes()).hexdigest()[:24]
    output=out/f'{part}-{key}.png'
    if not output.exists():
        old_proj=partrender.PROJ;old_cam=partrender.CAM
        try:
            partrender.PROJ=projection.copy()
            camera=np.cross(projection[0],projection[1]);partrender.CAM=camera/np.linalg.norm(camera)
            partrender.render([(part,color,T)],output,size=tuple(size),fit=(1.,offset),min_area=.01,draw_edges=False)
        finally:partrender.PROJ=old_proj;partrender.CAM=old_cam
    rgb=cv2.cvtColor(cv2.imread(str(output)),cv2.COLOR_BGR2RGB)
    return dict(rgb=rgb,mask=background_mask(rgb,tolerance=0),world_origin_in_template=offset)


def edges(rgb,mask):
    rgb=rgb.copy();rgb[~mask]=245
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    edge=cv2.Canny(gray,35,85)>0
    boundary=cv2.morphologyEx(mask.astype(np.uint8),cv2.MORPH_GRADIENT,np.ones((3,3),np.uint8))>0
    return edge|boundary


def locate_part(scene,part,color,T,projection,out):
    """Return up to ten offset dicts sorted by score; no certified confidence."""
    template=native_template(part,color,T,projection,out)
    source_rgb=scene['rgb'];source_mask=scene.get('mask',background_mask(source_rgb))
    h,w=template['mask'].shape
    if h>source_rgb.shape[0] or w>source_rgb.shape[1]:return []
    target_edges=edges(source_rgb,source_mask)
    part_edges=edges(template['rgb'],template['mask'])
    if part_edges.sum()<5:return []
    distance=cv2.distanceTransform((~target_edges).astype(np.uint8),cv2.DIST_L2,3)
    proximity=np.exp(-distance/2.).astype(np.float32)
    edge_score=cv2.matchTemplate(proximity,part_edges.astype(np.float32),cv2.TM_CCORR)/part_edges.sum()
    coverage=cv2.matchTemplate(source_mask.astype(np.float32),template['mask'].astype(np.float32),cv2.TM_CCORR)/max(1,template['mask'].sum())
    combined=.85*edge_score+.15*coverage
    work=combined.copy();hypotheses=[]
    for _ in range(min(10,work.size)):
        y,x=np.unravel_index(np.argmax(work),work.shape)
        if work[y,x]<0:break
        origin=np.array([x,y])+template['world_origin_in_template']
        hypotheses.append(dict(image_origin=origin.tolist(),template_top_left=[int(x),int(y)],
            part_origin=(origin+np.asarray(projection)@np.asarray(T)[:3,3]).tolist(),
            score=float(combined[y,x]),edge_score=float(edge_score[y,x]),coverage=float(coverage[y,x]),
            certified=False))
        work[max(0,y-3):y+4,max(0,x-3):x+4]=-1
    return hypotheses


def run(out):
    out.mkdir(parents=True,exist_ok=True)
    M=np.array([[1.1,0,-.8],[.5,1,.7]])
    T=np.eye(4);T[:3,3]=[13,-8,21]
    template=native_template('99780',15,T,M,out/'synthetic-cache')
    rgb=template['rgb'];mask=template['mask'];h,w=mask.shape;xy=np.array([43,37])
    expected=xy+template['world_origin_in_template'];tests=[]
    for occluded in (False,True):
        canvas=np.full((h+90,w+100,3),245,np.uint8);canvas[xy[1]:xy[1]+h,xy[0]:xy[0]+w]=rgb
        if occluded:canvas[xy[1]:xy[1]+h//3,xy[0]:xy[0]+w]=[55,75,110]
        proposals=locate_part(dict(rgb=canvas,mask=background_mask(canvas,tolerance=0)), '99780',15,T,M,out/'synthetic-cache')
        error=float(np.linalg.norm(np.asarray(proposals[0]['image_origin'])-expected))
        tests.append(dict(occluded=occluded,expected_image_origin=expected.tolist(),error_px=error,hypotheses=proposals))
        cv2.imwrite(str(out/f'synthetic-{occluded}.png'),cv2.cvtColor(canvas,cv2.COLOR_RGB2BGR))
    # Runtime PDF reconstruction proposal, not independent model truth.
    import pymupdf
    doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf')
    model=Path('output/pdf-placement-beam/40377-pair-camera-v1/pair_000.ldr')
    found=None
    for line in model.read_text().splitlines():
        fields=line.split()
        if len(fields)>=15 and fields[0]=='1' and fields[14]=='15571.dat':
            found=np.eye(4);found[:3,3]=list(map(float,fields[2:5]));found[:3,:3]=np.asarray(list(map(float,fields[5:14]))).reshape(3,3)
    if found is None:raise ValueError('Runtime pair proposal lacks15571')
    scene=scene_images(doc,doc[3])[0];graph=component_graph(scene)
    scene=dict(scene,mask=graph['components'][0]['mask'])
    calibration=camera_for(doc,3,lookahead=0)
    hypotheses=locate_part(scene,'15571',15,found,np.asarray(calibration['matrix']),out/'pdf-cache')
    record=dict(synthetic_tests=tests,pdf=dict(page=3,xref=scene['xref'],runtime_pose_source=str(model),
        runtime_pose_sha256=hashlib.sha256(model.read_bytes()).hexdigest(),projection=calibration['matrix'],
        part_transform=found.tolist(),hypotheses=hypotheses),
        limitations=['No independent PDF localization truth; matches are hypotheses.',
                     'Only integer template shifts searched; partial occlusion can bias registration.'])
    (out/'results.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
    view=scene['rgb'].copy()
    for i,p in enumerate(hypotheses[:3]):
        pos=tuple(np.round(p['part_origin']).astype(int));cv2.circle(view,pos,3,(255,0,255),1);cv2.putText(view,str(i),pos,cv2.FONT_HERSHEY_SIMPLEX,.4,(255,0,255),1)
    cv2.imwrite(str(out/'pdf-registration.png'),cv2.cvtColor(view,cv2.COLOR_RGB2BGR))
    assert all(t['error_px']<=2 for t in tests),tests


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True)
    run(parser.parse_args().out)
