"""Evaluation-only page13 mold distinction; no runtime hypothesis selection."""
import json
from pathlib import Path
import numpy as np
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary
from placement_arrow_contacts import part_conns
from placement_diagnose_alias_poses import yaw_equivalent_score
from pose_score import read_parts,score


def main():
    lib=PartLibrary();geometry={};connectors={}
    for name in ('4032a','4032b'):
        parsed=colored_triangles(name,72,resolver=lib.resolve)
        points=parsed['triangles'].reshape(-1,3)
        geometry[name]=dict(bounds=[points.min(0).tolist(),points.max(0).tolist()],files=parsed['files'])
        connectors[name]=sorted(json.dumps(c,sort_keys=True,default=lambda v:np.asarray(v).tolist()) for c in part_conns(name))
    equivalent=geometry['4032a']['bounds']==geometry['4032b']['bounds'] and connectors['4032a']==connectors['4032b']
    truth=read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')
    rows=[]
    for variant in ('4032a','4032b'):
        run=Path('output/pdf-placement-vector/page13-variant-group-v3')/variant
        metadata=json.loads((run/'results.json').read_text())
        assert metadata['truth_used'] is False and metadata['runtime_vlm_calls']==0
        for path in sorted(run.glob('group_*.ldr')):
            recon=read_parts(path)
            row=dict(variant=variant,file=path.name,raw=score(recon,truth),structural=yaw_equivalent_score(recon,truth))
            if equivalent:
                normalize=lambda parts:[('4032a' if p in ('4032a','4032b') else p,c,t,R) for p,c,t,R in parts]
                row['auxiliary_mold_agnostic_pose']=yaw_equivalent_score(normalize(recon),normalize(truth))
            rows.append(row)
    result=dict(scope='Posthoc evaluation only; mold identity remains distinct. Auxiliary normalization compares attachment frame only and does not certify physical mold equivalence.',geometry=geometry,connectors=connectors,bounds_and_connector_registry_equal=equivalent,rows=rows)
    out=Path('output/pdf-placement-diagnosis/page13-variants-posthoc.json');out.write_text(json.dumps(result,indent=2))
    print(json.dumps(dict(equivalent_attachment_frame=equivalent,selected=[r for r in rows if r['file']=='group_000.ldr'])))


if __name__=='__main__':main()
