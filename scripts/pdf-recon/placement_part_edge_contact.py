"""PDF-only visual diagnostic of candidate part orientation matching."""
import json
import os
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from placement_part_edges import (cube_rotations,part_orientation_scores,
                                 render_rotations,canonical,features,compare)
from vector_scene import scene_images
from vector_scene_components import component_graph
from recon_extract import pdf_inventory as bom
from recon_extract.pdf_icon_matcher import icon_box

out=Path(os.environ.get('PART_EDGE_CONTACT_OUT','output/pdf-placement-vector/part-edge-contact'));out.mkdir(parents=True,exist_ok=True)
doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf')
scene=next(s for s in scene_images(doc,doc[2]) if s['xref']==13)
components=component_graph(scene)['components'];rotations=cube_rotations()
catalog=bom.bridge_catalog(bom.load_studio_catalog(Path('C:/git/clego/extracted/studio_earlyaccess/app/data')),
                           bom.load_catalog(Path('C:/git/clego/elements.csv')))
inventory=bom.extract(doc,catalog,namespace='ldraw');icons={}
for record in inventory['records']:
    if record.get('part') not in ('99780','15571'):continue
    box=icon_box(doc[record['page']],record,inventory['records'])
    if box:
        pix=doc[record['page']].get_pixmap(matrix=pymupdf.Matrix(4,4),clip=pymupdf.Rect(box),alpha=False)
        icons[record['part']]=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
sheet=Image.new('RGB',(1540,560),'#dddddd');draw=ImageDraw.Draw(sheet);records=[]
def cell(image,col,row,label):
    image=image.copy();image.thumbnail((210,225));sheet.paste(image,(col*220,row*280+45));draw.text((col*220+2,row*280+2),label,fill='black')
for ci,component in enumerate(components):
    target_rgb,target_mask=canonical(scene['rgb'],component['mask'])
    cell(Image.fromarray(target_rgb),0,ci,f'PDF component {ci}')
    for pi,part in enumerate(('99780','15571')):
        if part in icons:cell(icons[part],1+pi*3,ci,f'PDF BOM {part}')
        renders=render_rotations(part,15,rotations,out/'cache')
        scores=part_orientation_scores(part,15,rotations,scene,component,out/'cache')
        best=np.argsort(-scores)[:2]
        details=[]
        for rank,k in enumerate(best):
            rgb,mask=renders[k]
            cell(Image.fromarray(rgb),2+pi*3+rank,ci,f'{part} rank{rank+1} rot{k}\nscore {scores[k]:.3f}')
            _,metrics=compare(features(target_rgb,target_mask),features(rgb,mask))
            details.append(dict(rotation=int(k),score=float(scores[k]),metrics=metrics,transform=rotations[k].tolist()))
        records.append(dict(component=ci,part=part,top=details))
sheet.save(out/'contact.png')
(out/'scores.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
