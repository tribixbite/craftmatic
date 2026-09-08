"""Inspect saved PDF bootstrap alternatives; no reference poses read."""
import argparse
import json
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from vector_scene import scene_images
from placement_arrow_contacts import read_items
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_halo import refine_arrow_halo
from placement_arrow_pair_topology import arrow_pair_components
from placement_material_scene_score import MaterialFeatureSceneScorer


def run(directory):
    report=json.loads((directory/'results.json').read_text());assert report['truth_used'] is False
    with pymupdf.open(report['pdf']) as doc:
        scene=next(s for s in scene_images(doc,doc[report['source_page']]) if s['xref']==report['source_xref'])
    graph=conservative_components(scene,protected_cad_colors(report['parts'])['rgb']);graph=refine_arrow_halo(scene,graph,protected_cad_colors(report['parts'])['rgb'])
    components,_=arrow_pair_components(graph);M=np.asarray(report['projection'])
    panels=[('Native exploded scene',scene['rgb'])];readback=[]
    stable=MaterialFeatureSceneScorer(dict(scene,mask=components[0]['mask']),plane_depth=True)
    complete=MaterialFeatureSceneScorer(scene,plane_depth=True,span_tolerance=10)
    for row in report['results'][:5]:
        items=read_items(directory/row['file']);ev=stable.score(items[:2],M,directory/(Path(row['file']).stem+'-stable.png'))
        panels.append((row['file']+' stable',stable.last_outline.copy()))
        if len(readback)==0:
            complete.score(items,M,directory/'assembled-preview.png');panels.append(('Assembled preview only',complete.last_outline.copy()))
        readback.append(dict(file=row['file'],stable_score=ev['score'],expected_score=row['stable']['score']))
    sheet=Image.new('RGB',(210*len(panels),290),'white');draw=ImageDraw.Draw(sheet)
    for i,(name,rgb) in enumerate(panels):
        image=Image.fromarray(rgb);image=image.resize((rgb.shape[1]*2,rgb.shape[0]*2));image.thumbnail((205,255));sheet.paste(image,(210*i,30));draw.text((210*i+3,5),name,fill='black')
    sheet.save(directory/'native-alternatives.png');(directory/'preview-readback.json').write_text(json.dumps(readback,indent=2));print(json.dumps(readback))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);run(p.parse_args().directory)
