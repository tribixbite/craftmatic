"""Profile saved runtime candidates; no reference model or selection changes."""
import cProfile,json,pstats,time
from pathlib import Path
import numpy as np
import pymupdf
from placement_arrow_contacts import read_items
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_material_scene_score import MaterialFeatureSceneScorer
from vector_scene import scene_images


def fixture():
    run=Path('output/pdf-placement-beam/40377-automatic-to26-v1/page-010/placement');metadata=json.loads((run/'results.json').read_text())
    assert metadata['truth_used'] is False and metadata['runtime_vlm_calls']==0
    rows=[dict(file=r['file'],items=read_items(run/r['file']),projection=np.asarray(r['projection'])) for r in metadata['results']]
    palette=protected_cad_colors(sorted(set((p,c) for row in rows for p,c,T in row['items'])))
    with pymupdf.open(metadata['pdf']) as doc:scene=next(s for s in scene_images(doc,doc[metadata['page']]) if s['xref']==metadata['xref'])
    scene=dict(scene,mask=conservative_components(scene,palette['rgb'])['clean_mask'])
    return scene,rows


if __name__=='__main__':
    scene,rows=fixture();scorer=MaterialFeatureSceneScorer(scene,plane_depth=True)
    for row in rows:scorer.score(row['items'],row['projection'])
    profiler=cProfile.Profile();profiler.enable();start=time.perf_counter()
    results=[dict(file=row['file'],evidence=scorer.score(row['items'],row['projection'])) for row in rows]
    elapsed=time.perf_counter()-start;profiler.disable();out=Path('output/pdf-placement-diagnosis/material-profile');out.mkdir(exist_ok=True)
    with (out/'profile.txt').open('w') as stream:pstats.Stats(profiler,stream=stream).sort_stats('cumtime').print_stats(35)
    (out/'results.json').write_text(json.dumps(dict(seconds=elapsed,candidates=len(rows),results=results,truth_used=False),indent=2));print(elapsed)
