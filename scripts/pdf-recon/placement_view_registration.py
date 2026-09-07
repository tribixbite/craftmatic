"""Joint known-part image-origin agreement over 24 proper camera rotations.

PDF scene + runtime assembled hypotheses + universal CAD only. Hidden parts
can produce spurious agreement, so candidates are explicitly uncertified.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from placement_part_edges import cube_rotations
from placement_registration import locate_part,native_template
from vector_scene import scene_images
from vector_scene_components import component_graph


def color_supported_locations(scene,part,color,T,projection,out):
    """Re-rank edge locations by visible CAD/PDF chroma support.

    Missing-color pixels may be occlusion; they are not proof of impossibility.
    Some actual color-compatible internal edge evidence is nevertheless needed
    before a location can constrain the shared image origin.
    """
    import cv2
    locations=locate_part(scene,part,color,T,projection,out)
    template=native_template(part,color,T,projection,out)
    rgb=template['rgb'].astype(float);mask=template['mask']
    # RGB proportions are insensitive to multiplicative face shading.
    expected=rgb/np.maximum(1.,rgb.sum(axis=2,keepdims=True))
    gray=cv2.cvtColor(template['rgb'],cv2.COLOR_RGB2GRAY)
    internal=(cv2.Canny(gray,35,85)>0)&(cv2.erode(mask.astype(np.uint8),np.ones((3,3),np.uint8))>0)
    if internal.sum()<3:internal=mask
    h,w=mask.shape
    output=[]
    for location in locations:
        x,y=location['template_top_left'];patch=scene['rgb'][y:y+h,x:x+w].astype(float)
        observed=patch/np.maximum(1.,patch.sum(axis=2,keepdims=True))
        distance=np.linalg.norm(observed-expected,axis=2)
        # Do not count black outlines as proof that a white face is visible:
        # an achromatic part must have compatible brightness at some pixels.
        bright_expected=rgb.mean(axis=2)>160
        source_foreground=scene['mask'][y:y+h,x:x+w] if 'mask' in scene else np.ones(mask.shape,bool)
        achromatic_expected=np.ptp(expected,axis=2)<.045
        compatible=(distance<.13)&(~bright_expected|(patch.mean(axis=2)>110))&source_foreground
        compatible&=(~achromatic_expected)|(np.ptp(observed,axis=2)<.08)
        fraction=float((compatible&mask).sum()/max(1,mask.sum()))
        edge_neighborhood=cv2.dilate(internal.astype(np.uint8),np.ones((3,3),np.uint8))>0
        edge_fraction=float((compatible&edge_neighborhood&mask).sum()/max(1,(edge_neighborhood&mask).sum()))
        supported=fraction>=.12 and edge_fraction>=.10
        output.append(dict(location,color_fraction=fraction,color_edge_fraction=edge_fraction,
            color_supported=supported,edge_only_score=location['score'],
            score=location['score']*(.35+.65*np.sqrt(fraction*edge_fraction))))
    return sorted([r for r in output if r['color_supported']],key=lambda r:-r['score'])


def register_views(scene,items,projection,out,views=3,origins_per_view=2):
    """Return <=views records, each with projection and <=2 origin hypotheses.

    Mapping: image_xy = returned_projection @ world_xyz + image_origin.
    items must be two (part,color,4x4 world transform) tuples. Proper camera
    rotations vary only viewing direction; known part world poses stay fixed.
    """
    if len(items)!=2:raise ValueError('Exactly two known part instances required')
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    projection=np.asarray(projection,float);ranked=[]
    for index,rotation in enumerate(cube_rotations()):
        matrix=projection@rotation[:3,:3]
        predictions=[color_supported_locations(scene,p,c,T,matrix,out/'cache') for p,c,T in items]
        if not all(predictions):continue
        stud_scale=max(1.,20*np.mean(np.linalg.norm(matrix,axis=0)))
        candidates=[]
        for first in predictions[0]:
            for second in predictions[1]:
                a=np.asarray(first['image_origin']);b=np.asarray(second['image_origin'])
                separation=float(np.linalg.norm(a-b))
                appearance=(first['score']+second['score'])/2
                # One camera origin must explain both known world placements.
                score=appearance-separation/stud_scale
                origin=(a+b)/2
                candidates.append(dict(image_origin=origin.tolist(),score=float(score),
                    appearance_score=float(appearance),origin_disagreement_px=separation,
                    individual=[first,second],certified=False))
        candidates.sort(key=lambda r:-r['score']);kept=[]
        for candidate in candidates:
            if any(np.linalg.norm(np.asarray(candidate['image_origin'])-r['image_origin'])<4 for r in kept):continue
            kept.append(candidate)
            if len(kept)>=origins_per_view:break
        ranked.append(dict(camera_rotation_index=index,camera_rotation=rotation[:3,:3].tolist(),
            projection=matrix.tolist(),origins=kept,score=kept[0]['score']))
    ranked.sort(key=lambda r:-r['score'])
    return ranked[:views]


def diagnostic(out):
    out.mkdir(parents=True,exist_ok=True)
    runtime=Path('output/pdf-placement-beam/40377-pair-camera-v1')
    model=runtime/'pair_000.ldr';items=[]
    for line in model.read_text().splitlines():
        fields=line.split()
        if len(fields)>=15 and fields[0]=='1':
            T=np.eye(4);T[:3,3]=list(map(float,fields[2:5]));T[:3,:3]=np.asarray(list(map(float,fields[5:14]))).reshape(3,3)
            items.append((fields[14].removesuffix('.dat'),int(fields[1]),T))
    projection=np.asarray(json.loads((runtime/'results.json').read_text())['camera']['matrix'])
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf');doc=pymupdf.open(pdf)
    scene=scene_images(doc,doc[4])[0];graph=component_graph(scene)
    scene=dict(scene,mask=graph['components'][0]['mask'])
    proposals=register_views(scene,items,projection,out)
    result=dict(protocol='Runtime PDF pair pose + PDF scene; no OMR or external pose inputs',
        pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),runtime_pose=str(model),
        runtime_pose_sha256=hashlib.sha256(model.read_bytes()).hexdigest(),page=4,xref=scene['xref'],
        input_projection=projection.tolist(),proposals=proposals,
        limitations=['Fixed supplied scale; camera scale changes require a separate hypothesis.',
          'Occluded parts can match unrelated edges; agreement is not pose certification.',
          'All24 camera rotations include non-upright views; no booklet rotation prior imposed.'])
    (out/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    im=Image.fromarray(scene['rgb']).resize((scene['rgb'].shape[1]*3,scene['rgb'].shape[0]*3));draw=ImageDraw.Draw(im)
    colors=['magenta','cyan','orange']
    for i,view in enumerate(proposals):
        matrix=np.asarray(view['projection']);origin=np.asarray(view['origins'][0]['image_origin'])
        for j,(_,_,T) in enumerate(items):
            point=(matrix@T[:3,3]+origin)*3
            draw.ellipse((point[0]-4,point[1]-4,point[0]+4,point[1]+4),outline=colors[i],width=2)
            draw.text(tuple(point),f'v{i}p{j}',fill=colors[i])
    im.save(out/'registered-origins.png')


def color_selftest(out):
    """Same shape in white and blue: only white can support a white part."""
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    projection=np.array([[1.,0,-1.],[.5,1.,.5]]);T=np.eye(4)
    template=native_template('3023b',15,T,projection,out/'test-cache')
    rgb=template['rgb'];mask=template['mask'];h,w=mask.shape
    canvas=np.full((h+20,2*w+40,3),245,np.uint8);foreground=np.zeros(canvas.shape[:2],bool)
    canvas[10:10+h,10:10+w]=rgb;foreground[10:10+h,10:10+w]=mask
    blue=rgb.copy();blue[mask]=np.array([20,60,160],np.uint8)
    canvas[10:10+h,w+30:2*w+30]=blue;foreground[10:10+h,w+30:2*w+30]=mask
    proposals=color_supported_locations(dict(rgb=canvas,mask=foreground),'3023b',15,T,projection,out/'test-cache')
    result=dict(proposals=proposals,white_top_left=[10,10],blue_top_left=[w+30,10])
    (out/'color-selftest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    assert proposals and abs(proposals[0]['template_top_left'][0]-10)<=2
    assert not any(abs(p['template_top_left'][0]-(w+30))<=2 for p in proposals)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();color_selftest(args.out);diagnostic(args.out)
