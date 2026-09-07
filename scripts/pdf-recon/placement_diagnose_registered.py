"""Independent pose and surface-equivalence diagnostics after reconstruction."""
from pathlib import Path
import json,sys
import numpy as np
from scipy.spatial import cKDTree
from pose_score import read_parts,score
from placement_diagnose import position_upper
from placement_diagnose_pair_rank import to_items
from dbix_settle import part_points

if __name__=='__main__':
    run=Path(sys.argv[1]);truth=read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd');rows=[]
    for path in sorted(run.glob('beam_*.ldr')):
        parts=read_parts(path);rows.append({'file':path.name,'strict':score(parts,truth),'position_only':position_upper(parts,truth)})
    selected=read_parts(run/'beam_00.ldr');ra=next(p for p in selected if p[0]=='99780');ta=next(p for p in truth if p[0]=='99780')
    R=ta[3]@ra[3].T;offset=ta[2]-R@ra[2];details=[]
    for index,(part,color,p,rot) in enumerate(selected):
        p=R@p+offset;rot=R@rot
        points=np.asarray(part_points(part));surface=points@rot.T+p
        candidates=[]
        for i,(tp,tc,pos,tr) in enumerate(truth):
            if (tp,tc)!=(part,color):continue
            target=points@tr.T+pos
            hausdorff=max(float(cKDTree(surface).query(target)[0].max()),float(cKDTree(target).query(surface)[0].max()))
            candidates.append({'truth_index':i,'position_error_max_ldu':float(np.max(np.abs(p-pos))),'rotation_error_max':float(np.max(np.abs(rot-tr))),'sampled_surface_hausdorff_ldu':hausdorff,'truth_position':pos.tolist(),'truth_rotation':tr.tolist()})
        candidates.sort(key=lambda c:c['sampled_surface_hausdorff_ldu'])
        details.append({'index':index,'part':part,'mapped_position':p.tolist(),'mapped_rotation':rot.tolist(),'nearest_same_id_truth':candidates[:2]})
    report={'scope':'Evaluation-only full independent truth; sampled surface distance is a diagnostic, not a universal symmetry certificate','beams':rows,'selected_part_details':details}
    out=Path('output/pdf-placement-diagnosis')/(run.name+'-geometry.json');out.write_text(json.dumps(report,indent=2));print(out)
