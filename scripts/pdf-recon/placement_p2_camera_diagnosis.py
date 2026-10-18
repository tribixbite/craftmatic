"""Own-page camera/registration diagnosis for the first repeated-quantity step."""
import itertools
import json
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from placement_arrow_contacts import read_items
from placement_camera import infer_camera,infer_camera_robust,infer_camera_row
from placement_studs import detect_studs
from placement_part_edges import cube_rotations
from placement_colored_scene_score import ColoredSceneScorer
from vector_scene import scene_images
from vector_scene_components import component_graph

out=Path('output/pdf-placement-vector/p2-camera-diagnosis');out.mkdir(parents=True,exist_ok=True)
source=Path('output/pdf-placement-beam/40377-contacts-six-v1/model.ldr');items=read_items(source)
baseline=np.asarray(json.loads(Path('output/pdf-placement-beam/40377-pair-camera-v1/results.json').read_text())['camera']['matrix'])
doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf');scene=scene_images(doc,doc[2])[0]
graph=component_graph(scene);main=graph['components'][0];main_scene=dict(scene,mask=main['mask'])
detections=detect_studs(scene['rgb'],main['mask'])
inferences={name:func(detections) for name,func in [('full',infer_camera),('robust',infer_camera_robust),('row',infer_camera_row)]}
cameras=[('next-page-baseline',baseline)]
for name,result in inferences.items():
    if result['ok']:cameras.append((name,np.asarray(result['matrix'])))
row_subsets=[]
for subset in itertools.combinations(range(len(detections)),3):
    result=infer_camera_row([detections[i] for i in subset])
    if result['ok']:
        row_subsets.append(dict(indices=list(subset),inference=result))
        matrix=np.asarray(result['matrix'])
        if not any(np.linalg.norm(matrix-M)<.04 for _,M in cameras):cameras.append((f'row-subset-{subset}',matrix))
scorer=ColoredSceneScorer(main_scene);records=[]
for order,current in enumerate([items[:2]+[items[3]],items[:3]]):
    for name,calibration in cameras:
        for view,R in enumerate(cube_rotations()):
            projection=calibration@R[:3,:3]
            evidence=scorer.score(current,projection)
            records.append(dict(order=order,camera_source=name,view=view,projection=projection.tolist(),evidence=evidence))
records.sort(key=lambda r:-r['evidence']['score'])
sheet=Image.new('RGB',(1000,360),'#eeeeee');draw=ImageDraw.Draw(sheet)
native=scene['rgb'].copy();native[~main['mask']]=245;im=Image.fromarray(native);im.thumbnail((240,300));sheet.paste(im,(0,40));draw.text((3,3),'Native main component',fill='black')
for i,record in enumerate(records[:3]):
    current=items[:2]+[items[3]] if record['order']==0 else items[:3]
    path=out/f'top-{i}.png';scorer.score(current,np.asarray(record['projection']),path)
    im=Image.open(path);im.thumbnail((240,300));sheet.paste(im,((i+1)*250,40))
    draw.text(((i+1)*250+3,3),f"order{record['order']} view{record['view']} score{record['evidence']['score']:.3f}",fill='black')
sheet.save(out/'comparison.png')
result=dict(protocol='Own PDF scene and runtime prefix only; no model truth',page=2,xref=scene['xref'],
    detections=detections,inferences=inferences,row_subsets=row_subsets,camera_hypotheses=len(cameras),
    scored_hypotheses=len(records),records=records,
    limitations=['Two main-component composition hypotheses are from an existing runtime prefix.',
      'Fixed-scale bbox-center origin optimizes translation only, not independent feature registration.',
      'Scores do not certify camera or placement accuracy.'])
(out/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
