"""Runtime-only throughput measurement on saved legal PDF group placements."""
from pathlib import Path
import json,numpy as np,pymupdf
from placement_arrow_contacts import read_items
from placement_repeated_coarse import shortlist_pairs
from placement_colored_scene_score import ColoredSceneScorer
from placement_arrow_mask import conservative_components,protected_cad_colors
from vector_scene import scene_images

if __name__=='__main__':
    cache=json.loads(Path('output/pdf-placement-diagnosis/page7-legal-placements.json').read_text())
    base=read_items(cache['base_source']);placements=[dict(items=[(p,c,np.asarray(T)) for p,c,T in r['items']]) for r in cache['placements']]
    camera=json.loads(Path('output/pdf-placement-beam/40377-gpu-seventeen-v1/camera.json').read_text())
    M=np.asarray(camera.get('matrix') or camera['hypotheses'][0]['matrix'])
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:scene=scene_images(doc,doc[7])[0]
    palette=protected_cad_colors([(p,c) for p,c,T in base+placements[0]['items']]);graph=conservative_components(scene,protected_colors=palette['rgb']);scene=dict(scene,mask=graph['clean_mask'])
    chosen,summary=shortlist_pairs(base,placements,M,ColoredSceneScorer(scene),limit=256)
    out=Path('output/pdf-placement-diagnosis/repeated-coarse-benchmark.json');out.write_text(json.dumps(dict(summary=summary,selected=chosen),indent=2));print(json.dumps(summary,indent=2))
