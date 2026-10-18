"""Review images from a saved PDF-derived group; never a model truth input."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from vector_scene import scene_images
from placement_arrow_mask import conservative_components,protected_cad_colors
from placement_arrow_pair_topology import arrow_pair_components
from placement_material_scene_score import MaterialFeatureSceneScorer


def load_own_group(path):
    items=[]
    for line in path.read_text().splitlines():
        words=line.split()
        if not words or words[0]!='1':continue
        T=np.eye(4);T[:3,3]=list(map(float,words[2:5]));T[:3,:3]=np.array(list(map(float,words[5:14]))).reshape(3,3)
        items.append((words[14].removesuffix('.dat'),int(words[1]),T))
    return items


def run(directory):
    report=json.loads((directory/'results.json').read_text());assert not report['truth_used']
    with pymupdf.open(report['pdf']) as doc:
        scene=next(s for s in scene_images(doc,doc[report['source_page']]) if s['xref']==report['second_source_xref'])
    panels=[('Native exploded stage',scene['rgb'])];checks={}
    for branch in report['branches']:
        folder=Path(branch['directory']);data=json.loads((folder/'results.json').read_text())
        items=load_own_group(folder/data['results'][0]['file']);M=np.asarray(data['projection'])
        graph=conservative_components(scene,protected_cad_colors([(p,c) for p,c,T in items])['rgb'])
        components,_=arrow_pair_components(graph)
        stable=MaterialFeatureSceneScorer(dict(scene,mask=components[0]['mask']),plane_depth=True)
        ev=stable.score(items[:3],M,folder/'stable-preview.png')
        panels.append((branch['part_choice']['part']+' stable component',stable.last_outline.copy()))
        assembled=MaterialFeatureSceneScorer(scene,plane_depth=True,span_tolerance=10)
        assembled.score(items,M,folder/'assembled-preview.png')
        panels.append((branch['part_choice']['part']+' assembled (preview only)',assembled.last_outline.copy()))
        checks[branch['part_choice']['part']]=dict(stable_silhouette_iou=ev['silhouette_iou'],stable_material_iou=ev['material_color_score'])
    width=300;height=400;contact=Image.new('RGB',(width*len(panels),height),'white');draw=ImageDraw.Draw(contact)
    for i,(label,rgb) in enumerate(panels):
        image=Image.fromarray(rgb);image.thumbnail((width-10,height-35));contact.paste(image,(i*width+(width-image.width)//2,30));draw.text((i*width+6,6),label,fill='black')
    contact.save(directory/'native-group-contact.png')
    result=dict(truth_used=False,checks=checks,assembled_preview_is_not_fit_evidence=True)
    (directory/'preview-checks.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);run(p.parse_args().directory)
