"""Pose-free fixed-registration occupancy preflight, no assembly selection."""
import argparse,hashlib,json
from pathlib import Path
import numpy as np,pymupdf
from placement_arrow_contacts import read_items
from placement_material_scene_score import MaterialFeatureSceneScorer
from placement_occupancy_screen import screen
from vector_scene import scene_images


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--registry',type=Path,required=True);p.add_argument('--registration',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--views',type=int,default=12);a=p.parse_args()
    registry=json.loads(a.registry.read_text());registration=json.loads(a.registration.read_text())
    assert registry['truth_used'] is False and registration['truth_used'] is False
    assert registry['runtime_vlm_calls']==registration['runtime_vlm_calls']==0
    assert registry['pdf_sha256']==registration['pdf_sha256']==hashlib.sha256(Path(registry['pdf']).read_bytes()).hexdigest()
    assert registry['base_sha256']==registration['base_sha256']==hashlib.sha256(Path(registry['base_source']).read_bytes()).hexdigest()
    assert registry['page']==registration['page']
    with pymupdf.open(registry['pdf']) as doc:scene=next(s for s in scene_images(doc,doc[registry['page']]) if s['xref']==registration['xref'])
    scorer=MaterialFeatureSceneScorer(scene,plane_depth=True);base=read_items(registry['base_source']);placements=[dict(items=[(registry['part'],15,np.asarray(T))]) for T in registry['poses']];rows=[]
    a.out.mkdir(parents=True,exist_ok=False)
    for index,view in enumerate(registration['hypotheses'][:a.views]):
        result=screen(base,placements,view['projection'],view['origin'],scorer);(a.out/f'view-{index:02}.json').write_text(json.dumps(result,indent=2))
        summary=dict(view=index,registration_score=view['score'],base=result['base'],registration_consistent=result['registration_consistent'],retained=len(result['retained_indices']),candidate_screen_skipped=result['candidate_screen_skipped']);rows.append(summary);print(json.dumps(summary),flush=True)
    (a.out/'results.json').write_text(json.dumps(dict(views=rows,truth_used=False,runtime_vlm_calls=0,registry_sha256=hashlib.sha256(a.registry.read_bytes()).hexdigest(),registration_sha256=hashlib.sha256(a.registration.read_bytes()).hexdigest()),indent=2))
