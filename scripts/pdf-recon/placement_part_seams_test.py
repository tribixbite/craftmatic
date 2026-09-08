"""Synthetic ownership controls and PDF-only saved-candidate seam ablation."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
from placement_part_seams import instance_seams,PartSeamSceneScorer
from placement_cuda_layers import LayerRasterizer
from placement_arrow_contacts import read_items
from placement_arrow_mask import conservative_components,protected_cad_colors
from placement_arrow_pair_topology import arrow_pair_components
from vector_scene import scene_images


def controls():
    # Two rectangles, two triangles each, identical coplanar RGB/depth.
    triangles=np.array([[[2,2,1],[12,2,1],[12,22,1]],[[2,2,1],[12,22,1],[2,22,1]],
        [[12,2,1],[22,2,1],[22,22,1]],[[12,2,1],[22,22,1],[12,22,1]]],float)
    layer=LayerRasterizer().render_depth(triangles[None],np.full((1,4,3),150,np.uint8),25,25)
    mask=layer['mask'][0];owner=layer['owner'][0]
    split=instance_seams(mask,owner,[0,0,1,1]);whole=instance_seams(mask,owner,[0,0,0,0])
    # Rasterizer samples integer pixel centers, including both endpoints.
    assert split.sum()==21 and not whole.any()
    assert np.all(np.where(split)[1]==12)
    relabel=instance_seams(mask,owner,[77,77,3,3]);assert np.array_equal(split,relabel)
    rejected=False
    try:instance_seams(mask,owner,[0])
    except ValueError:rejected=True
    assert rejected
    return dict(coplanar_piece_joint_pixels=int(split.sum()),single_piece_triangulation_seams=int(whole.sum()),
        instance_relabel_invariant=True,invalid_owner_rejected=True)


def run(out,group,beam):
    out.mkdir(parents=True,exist_ok=True);report=dict(controls=controls(),truth_used=False,runtime_vlm_calls=0,seam_weight=.15)
    root=json.loads((group/'results.json').read_text());assert root['truth_used'] is False
    branch=group/'4032a';data=json.loads((branch/'results.json').read_text())
    items=read_items(branch/data['results'][0]['file'])[:3];M=np.asarray(data['projection'])
    with pymupdf.open(root['pdf']) as doc:
        scene=next(s for s in scene_images(doc,doc[root['source_page']]) if s['xref']==root['second_source_xref'])
    graph=conservative_components(scene,protected_cad_colors([(p,c) for p,c,T in items])['rgb'])
    parts,_=arrow_pair_components(graph);scene=dict(scene,mask=parts[0]['mask'])
    scorer=PartSeamSceneScorer(scene,plane_depth=True,seam_weight=.15)
    result=scorer.score(items,M,out/'page13-stable-seams.png');report['page13_stable']=result
    # Default-off equality checks the exact score, not an approximate tolerance.
    off=PartSeamSceneScorer(scene,plane_depth=True,seam_weight=0).score(items,M)
    assert off['score']==off['baseline_score'];report['default_off_score_exact']=True
    meta=json.loads((beam/'results.json').read_text());assert meta['truth_used'] is False and meta['runtime_vlm_calls']==0
    assert hashlib.sha256(Path(meta['pdf']).read_bytes()).hexdigest()==meta['pdf_sha256']
    rows=[];palette_parts=set()
    for row in meta['results']:
        pieces=read_items(beam/row['file']);palette_parts.update((p,c) for p,c,T in pieces)
        rows.append((row,pieces))
    with pymupdf.open(meta['pdf']) as doc:
        scene=next(s for s in scene_images(doc,doc[meta['page']]) if s['xref']==meta['xref'])
    clean=conservative_components(scene,protected_cad_colors(sorted(palette_parts))['rgb'])
    scorer=PartSeamSceneScorer(dict(scene,mask=clean['clean_mask']),plane_depth=True,seam_weight=.15)
    evidence=[]
    for row,pieces in rows:
        ev=scorer.score(pieces,np.asarray(row['projection']))
        evidence.append(dict(file=row['file'],evidence=ev))
    baseline=sorted(evidence,key=lambda r:-r['evidence']['baseline_score']);ranked=sorted(evidence,key=lambda r:-r['evidence']['score'])
    report.update(beam_source=str(beam),source_results_sha256=hashlib.sha256((beam/'results.json').read_bytes()).hexdigest(),
        baseline_selected=baseline[0]['file'],seam_selected=ranked[0]['file'],selection_preserved=baseline[0]['file']==ranked[0]['file'],results=ranked)
    selected,pieces=next((r,p) for r,p in rows if r['file']==ranked[0]['file'])
    scorer.score(pieces,np.asarray(selected['projection']),out/'page7-selected-seams.png')
    (out/'results.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='results'}))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);p.add_argument('--group',type=Path,required=True);p.add_argument('--beam',type=Path,required=True)
    a=p.parse_args();run(a.out,a.group,a.beam)
