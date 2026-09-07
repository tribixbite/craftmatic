"""Inspect independently fitted native component artwork, no reference poses."""
import argparse,json
from pathlib import Path
import numpy as np,pymupdf,cv2
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_pair_topology import arrow_pair_components
from placement_gpu_colored_scene_score import GpuColoredSceneScorer
from placement_part_edges import canonical
from placement_beam import rotations
from vector_scene import scene_images

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('evidence',type=Path);p.add_argument('camera',type=Path);a=p.parse_args()
    ev=json.loads(a.evidence.read_text());camera=json.loads(a.camera.read_text());group=ev['pair_groups'][0];parts=group['parts']
    with pymupdf.open(ev['pdf']) as doc:scene=next(s for s in scene_images(doc,doc[ev['source_page']]) if s['xref']==group['source_xref'])
    palette=protected_cad_colors(parts);components,_=arrow_pair_components(conservative_components(scene,protected_colors=palette['rgb']));panels=[]
    for ci,fit in enumerate(camera['component_fits']):
        current=dict(scene,mask=components[ci]['mask']);scorer=GpuColoredSceneScorer(current)
        part,color=parts[camera['component_part_indices'][ci]];R=rotations()[fit['rotation_index']]
        M=np.asarray(camera['matrix'])/camera['scale']*fit['scale'];scorer.score([(part,color,R)],M)
        for rgb,mask in [(scene['rgb'],current['mask']),(scorer.last_rgb,scorer.last_mask)]:
            rendered,_=canonical(rgb,mask);panels.append(rendered)
    sheet=np.concatenate(panels,axis=1);cv2.imwrite(str(a.camera.with_suffix('.png')),cv2.cvtColor(cv2.resize(sheet,None,fx=2,fy=2,interpolation=cv2.INTER_NEAREST),cv2.COLOR_RGB2BGR))
