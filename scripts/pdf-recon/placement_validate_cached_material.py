"""Exact optional scorer regression across20 native PDF runtime hypotheses."""
import json,time
from pathlib import Path
import numpy as np
from placement_profile_material import fixture
from placement_material_scene_score import MaterialFeatureSceneScorer
from placement_cached_material_score import CachedMaterialFeatureScorer


if __name__=='__main__':
    scene,rows=fixture();baseline=MaterialFeatureSceneScorer(scene,plane_depth=True);fast=CachedMaterialFeatureScorer(scene,plane_depth=True)
    results=[]
    for row in rows:
        a=baseline.score(row['items'],row['projection']);image=baseline.last_rgb.copy();mask=baseline.last_mask.copy();outline=baseline.last_outline.copy()
        b=fast.score(row['items'],row['projection']);exact=a==b
        pixels=np.array_equal(image,fast.last_rgb) and np.array_equal(mask,fast.last_mask) and np.array_equal(outline,fast.last_outline)
        assert exact and pixels
        results.append(dict(file=row['file'],evidence_exact=exact,pixels_exact=pixels,score=a['score']))
    times={'baseline':[],'cached':[]}
    for repeat in range(4):
        for name,scorer in [('baseline',baseline),('cached',fast)] if repeat%2==0 else [('cached',fast),('baseline',baseline)]:
            start=time.perf_counter()
            for row in rows:scorer.score(row['items'],row['projection'])
            times[name].append(time.perf_counter()-start)
    result=dict(results=results,times=times,median_speedup=float(np.median(times['baseline'])/np.median(times['cached'])),truth_used=False,baseline_changed=False)
    out=Path('output/pdf-placement-diagnosis/material-profile/cached-control.json');out.write_text(json.dumps(result,indent=2));print(json.dumps(dict(all20_exact=True,median_speedup=result['median_speedup'],times=times)))
