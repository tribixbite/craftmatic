"""Three allocated pieces, two native components: bounded PDF bootstrap.

Enumerates which single piece is detached and both stable-piece roots. The
stable component is scored only as a complete pair; the final piece uses
detached appearance, native arrow transverse alignment, and mating contacts.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
from placement_variant_exploded_group import EvidenceScorer,direction,rotation_key,write_group
from placement_native_scale_camera import scale_camera_hypotheses
from placement_arrow_mask import conservative_components,protected_cad_colors
from placement_arrow_pair_topology import arrow_pair_components
from placement_arrow_halo import refine_arrow_halo
from placement_arrow_contacts import batch_score_insertion_targets
from placement_beam import assembly,rotations
from placement_part_library import PartLibrary
from placement_group_equivalence import geometry_key
from vector_scene import scene_images


def run(pdf,allocation,out,stable_limit=24,plate_housing_gate=False,retain_score_ties=False):
    out.mkdir(parents=True,exist_ok=True);manifest=json.loads((allocation/'manifest.json').read_text())
    digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert manifest['pdf_only'] and manifest['runtime_vlm_calls']==0
    assert (manifest.get('pdf_sha256') or manifest['inputs_sha256'][manifest['pdf']])==digest
    journal=json.loads((allocation/'journal.json').read_text())
    first=next(row for row in journal if row['parts'].get('expected_qty',0)>0)
    evidence=first['parts']['crop_evidence']
    pieces=[(str(row['part']),int(row['color'])) for row in evidence for _ in range(row['qty'])]
    if len(pieces)!=3 or first['parts'].get('unresolved'):raise ValueError('Requires three resolved PDF callout hypotheses')
    with pymupdf.open(pdf) as doc:
        scenes=scene_images(doc,doc[first['page']]);scene=next(s for s in scenes if not s['inside_panel'])
    protected=protected_cad_colors(pieces);assert protected['complete']
    graph=conservative_components(scene,protected['rgb']);graph=refine_arrow_halo(scene,graph,protected['rgb'])
    components,topology=arrow_pair_components(graph)
    cameras=scale_camera_hypotheses(dict(scene,mask=graph['clean_mask']))
    (out/'cameras.json').write_text(json.dumps(cameras,indent=2))
    if not cameras['hypotheses']:raise ValueError('No native physical camera')
    # Retain the first native-resolution-success proposal for a bounded trial;
    # alternatives remain saved and must be tested if placement evidence fails.
    chosen=cameras['hypotheses'][0];M=np.asarray(chosen['camera']['matrix'])
    d,n=direction(graph['arrows']);stable_scorer=EvidenceScorer(dict(scene,mask=components[0]['mask']))
    loose_scorer=EvidenceScorer(dict(scene,mask=components[1]['mask']));Rlist=rotations();unique=list(dict.fromkeys(pieces))
    from placement_plate_housing_gate import PlateHousingGate
    gate=PlateHousingGate() if plate_housing_gate else None
    library=PartLibrary();geometry_cache={};stable=[];counts={};loose={}
    for detached in unique:
        loose[detached]={}
        for R in Rlist:
            fit=loose_scorer.score([(*detached,R)],M)
            if fit:loose[detached][rotation_key(R)]=fit
        if not loose[detached]:continue
        remaining=pieces.copy();remaining.remove(detached)
        for rootpart in dict.fromkeys(remaining):
            others=remaining.copy();others.remove(rootpart);nextpart=others[0]
            for R in Rlist:
                base=[(*rootpart,R)];current=assembly(base)
                for candidate in current.candidates(nextpart[0],check_collision=True,check_occlusion=False):
                    counts[str(detached)]=counts.get(str(detached),0)+1
                    items=base+[(*nextpart,candidate['T'])]
                    if gate and not gate.check(items):continue
                    fit=stable_scorer.score(items,M)
                    if fit:stable.append(dict(items=items,detached=detached,stable=fit))
    stable.sort(key=lambda row:-row['stable']['score']);retained=[];seen=set()
    def serial(row):return {k:v for k,v in row.items() if k!='items'}|dict(items=[dict(part=p,color=c,T=T.tolist()) for p,c,T in row['items']])
    (out/'latent-stable-pairs.json').write_text(json.dumps(dict(pdf_sha256=digest,truth_used=False,runtime_vlm_calls=0,
        projection=M.tolist(),rows=[serial(r) for r in stable],all_scored_pairs_preserved=True),indent=2))
    cutoff=None
    for row in stable:
        if cutoff is not None and row['stable']['score']<cutoff-1e-9:break
        # Keep camera-frame-sensitive distinct pairs; global-equivalent
        # orientations are not interchangeable against this fixed native view.
        key=(row['detached'],tuple((p,c,tuple(np.round(T.ravel(),4))) for p,c,T in row['items']))
        if key in seen:continue
        seen.add(key);retained.append(row)
        if len(retained)>=stable_limit:
            if not retain_score_ties:break
            if cutoff is None:cutoff=row['stable']['score']
    print('stable search',len(stable),'retained',len(retained),'ties',retain_score_ties,flush=True)
    completed=[]
    for row in retained:
        part,color=row['detached'];current=assembly(row['items'])
        poses=[c['T'] for c in current.candidates(part,check_collision=True,check_occlusion=False)]
        origin=np.asarray(row['stable']['image_origin'])
        contacts=batch_score_insertion_targets(row['items'],part,poses,M,origin,graph['arrows'])
        for T,contact in zip(poses,contacts):
            fit=loose[(part,color)].get(rotation_key(T))
            if fit is None:continue
            delta=origin+M@T[:3,3]-fit['image_origin'];transverse=abs(float(delta@n));slide=float(delta@d)
            if transverse>4 or slide<0:continue
            if gate and not gate.check(row['items']+[(part,color,T)]):continue
            score=row['stable']['score']+.6*fit['score']-.05*transverse+.3*contact.get('score',0.)
            completed.append(dict(items=row['items']+[(part,color,T)],score=score,stable=row['stable'],detached=fit,
                contact=contact,transverse=transverse,slide=slide))
    completed.sort(key=lambda row:-row['score']);results=[];seen=set();cutoff=None
    (out/'latent-complete.json').write_text(json.dumps(dict(pdf_sha256=digest,truth_used=False,runtime_vlm_calls=0,
        projection=M.tolist(),rows=[serial(r) for r in completed],all_scored_complete_hypotheses_preserved=True),indent=2))
    for row in completed:
        if cutoff is not None and row['score']<cutoff-1e-9:break
        key=geometry_key(row['items'],library.resolve,geometry_cache)
        if key in seen:continue
        seen.add(key);name=f'group_{len(results):03d}.ldr';write_group(out/name,row['items'])
        if not results:write_group(out/'model.ldr',row['items'])
        results.append({k:v for k,v in row.items() if k!='items'}|dict(file=name))
        if len(results)>=20:
            if not retain_score_ties:break
            if cutoff is None:cutoff=row['score']
    report=dict(pdf=str(pdf),pdf_sha256=digest,pdf_only=True,truth_used=False,runtime_vlm_calls=0,
        source_page=first['page'],source_xref=scene['xref'],source_allocation=str(allocation),
        allocation_sha256=hashlib.sha256((allocation/'journal.json').read_bytes()).hexdigest(),allocation_evidence=evidence,
        source_pose_records_used=False,parts=pieces,projection=M.tolist(),camera_scale=chosen['scale'],
        arrow_topology=topology,arrow_halo=graph['halo_evidence'],candidate_counts=counts,
        stable_hypotheses=len(stable),stable_retained=len(retained),complete_hypotheses=len(completed),results=results,
        plate_housing_gate=gate.evidence() if gate else None,
        retain_score_ties=retain_score_ties,all_scored_latent_states_saved=True,
        certified=False,limitations=['Historical unary PDF identities remain hypotheses, not a fresh capacity assignment.',
            'Bounded stable-pair retention and first successful camera; no certified exhaustive full-model search.',
            'No assembly truth was used; independent verification must follow selection.'])
    if gate:
        cache_report=dict(geometry_files=gate.files,truth_used=False,entries=[dict(part_a=p,part_b=q,
            relative_transform=list(T),has_proper_crossing=bool(value)) for (p,q,T),value in gate.cache.items()])
        (out/'plate-housing-cache.json').write_text(json.dumps(cache_report,indent=2))
    (out/'results.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k not in ('results','allocation_evidence','arrow_topology')}));print('top',results[0]['score'] if results else None)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--pdf',type=Path,required=True);p.add_argument('--allocation',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--stable-limit',type=int,default=24);p.add_argument('--plate-housing-gate',action='store_true');p.add_argument('--retain-score-ties',action='store_true')
    a=p.parse_args();run(a.pdf,a.allocation,a.out,a.stable_limit,a.plate_housing_gate,a.retain_score_ties)
