"""PDF slot-aware exploded isolated group construction with mold branches."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
from placement_palette_classes import palette_labels
from placement_colored_cad import _rgb
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_pair_topology import arrow_pair_components
from placement_arrow_contacts import batch_score_insertion_targets
from placement_beam import assembly,rotations
from placement_group_equivalence import geometry_key
from placement_part_library import PartLibrary
from vector_scene import scene_images
from placement_arrow_halo import refine_arrow_halo
from placement_material_scene_score import MaterialFeatureSceneScorer


class EvidenceScorer:
    def __init__(self,scene):
        self.scene=scene;self.gpu=MaterialFeatureSceneScorer(scene,plane_depth=True)
    def score(self,items,M):
        ev=self.gpu.score(items,M)
        if ev.get('bbox_rejected'):return None
        return dict(score=ev['score'],silhouette_iou=ev['silhouette_iou'],
            material_color_iou=ev['material_color_score'],edge=ev['edge_score'],
            image_origin=ev['image_origin'],material_counts=ev['material_regions'],
            span_error=ev['span_error'],metric=ev['scoring_protocol'],certified=False)


def direction(arrows):
    vectors=[np.asarray(a['direction'])/np.linalg.norm(a['direction']) for a in arrows]
    d=np.mean(vectors,0)
    if np.linalg.norm(d)<.8:raise ValueError('Arrows disagree')
    d/=np.linalg.norm(d);return d,np.array([-d[1],d[0]])


def rotation_key(T):return tuple(np.round(T[:3,:3].ravel(),5))


def write_group(path,items):
    lines=['0 PDF slot-aware isolated group; ambiguous mold branch retained; uncertified']
    for p,c,T in items:lines.append('1 '+str(c)+' '+' '.join(f'{v:g}' for v in [*T[:3,3],*T[:3,:3].ravel()])+' '+p+'.dat')
    path.write_text('\n'.join(lines)+'\n')


def run(audit_path,out):
    out.mkdir(parents=True,exist_ok=True);audit=json.loads(audit_path.read_text());assert not audit['truth_used']
    pdf=Path(audit['pdf']);assert hashlib.sha256(pdf.read_bytes()).hexdigest()==audit['pdf_sha256']
    page=next(p for p in audit['pages'] if p['kind']=='isolated_ordered_group')
    ordered=page['group_graph']['groups'][0]['ordered_xrefs']
    evidence={s['xref']:s for s in page['scene_evidence']}
    first=evidence[ordered[0]];second=evidence[ordered[1]]
    proposal=first['pair_partition_candidate']
    if not proposal:raise ValueError('No automatic first-stage pair partition')
    pairparts=[(str(c['part']),int(c['color'])) for c in proposal['parts']]
    if pairparts[0]!=pairparts[1]:raise ValueError('This bounded first stage requires identical allocated pieces')
    remaining=[a for a in page['allocations'] if a['inventory_slot']!=proposal['inventory_slot']]
    variants=[a for a in remaining if len(a['part_choices'])>1];uniques=[a for a in remaining if len(a['part_choices'])==1]
    if len(variants)!=1 or len(uniques)!=1 or any(a['qty']!=1 for a in remaining):raise ValueError('Expected one variant slot and one singleton slot')
    pinkchoice=uniques[0]['part_choices'][0];pink=(pinkchoice['part'],int(pinkchoice['color']))
    allparts=pairparts+[pink]+[(c['part'],int(c['color'])) for c in variants[0]['part_choices']]
    protected=protected_cad_colors(allparts)
    with pymupdf.open(pdf) as doc:
        scenes=scene_images(doc,doc[page['page']]);scene1=next(s for s in scenes if s['xref']==ordered[0]);scene2=next(s for s in scenes if s['xref']==ordered[1])
    graph1=conservative_components(scene1,protected['rgb']);graph1=refine_arrow_halo(scene1,graph1,protected['rgb']);components1,topology1=arrow_pair_components(graph1)
    original_graph2=conservative_components(scene2,protected['rgb']);graph2=refine_arrow_halo(scene2,original_graph2,protected['rgb'])
    # Independently check that the largest contiguous pink material region
    # is not removed by accepted-arrow mixture refinement.
    import cv2
    pinklabels,_=palette_labels(scene2['rgb'],scene2['mask'],np.asarray([_rgb(pink[1])],np.uint8))
    count,cc,stats,_=cv2.connectedComponentsWithStats((pinklabels==1).astype(np.uint8),8)
    largest=1+int(np.argmax(stats[1:,cv2.CC_STAT_AREA])) if count>1 else None
    pink_region=(cc==largest) if largest is not None else np.zeros_like(pinklabels,bool)
    pink_removed=int((pink_region&graph2['halo_mask']).sum())
    proposed_pink_removed=pink_removed
    if pink_removed:
        # Color-only evidence cannot safely distinguish pink from every red
        # arrow/background mixture. Abstain on this stage instead of erasing.
        graph2=dict(original_graph2,halo_mask=np.zeros_like(pink_region),halo_evidence=dict(
            added_pixels=0,abstained='Proposed halo intersects supported pink region',
            rejected_pink_intersection_pixels=pink_removed))
        pink_removed=0
    components2,topology2=arrow_pair_components(graph2)
    if not first['robust_camera'].get('ok') or not second['robust_camera'].get('ok'):raise ValueError('Native cameras unavailable')
    M1=np.asarray(first['robust_camera']['matrix']);M2=np.asarray(second['robust_camera']['matrix'])
    Rlist=rotations();part,color=pairparts[0];fits=[]
    for component in components1:
        scorer=EvidenceScorer(dict(scene1,mask=component['mask']));cache={}
        for R in Rlist:
            ev=scorer.score([(part,color,R)],M1)
            if ev:cache[rotation_key(R)]=ev
        fits.append(cache)
    d,n=direction(graph1['arrows']);pairrows=[]
    for R in Rlist:
        a=fits[0].get(rotation_key(R))
        if not a:continue
        root=[(part,color,R)];current=assembly(root)
        for candidate in current.candidates(part,check_collision=True,check_occlusion=False):
            T=candidate['T'];b=fits[1].get(rotation_key(T))
            if not b:continue
            shift=np.asarray(a['image_origin'])+M1@T[:3,3]-b['image_origin']
            transverse=abs(float(shift@n));slide=float(shift@d)
            if transverse>4 or slide<0:continue
            pairrows.append(dict(items=root+[(part,color,T)],score=(a['score']+b['score'])/2-.05*transverse,
                transverse=transverse,slide=slide,recipient=a,detached=b))
    pairrows.sort(key=lambda r:-r['score'])
    if not pairrows:raise ValueError('No arrow-aligned first-stage pair')
    library=PartLibrary();geometry_cache={};seen=set();bases=[]
    for row in pairrows:
        if row['score']<pairrows[0]['score']-.05:continue
        key=geometry_key(row['items'],library.resolve,geometry_cache)
        if key in seen:continue
        seen.add(key);bases.append(row)
        if len(bases)>=4:break
    (out/'stage1').mkdir(exist_ok=True)
    for i,row in enumerate(bases):write_group(out/'stage1'/f'pair_{i:03d}.ldr',row['items'])
    stable_scorer=EvidenceScorer(dict(scene2,mask=components2[0]['mask']))
    detached_scorer=EvidenceScorer(dict(scene2,mask=components2[1]['mask']));pinkfits={}
    for R in Rlist:
        ev=detached_scorer.score([(*pink,R)],M2)
        if ev:pinkfits[rotation_key(R)]=ev
    d,n=direction(graph2['arrows']);branches=[]
    for choice in variants[0]['part_choices']:
        roundpart,roundcolor=choice['part'],int(choice['color']);stable=[];candidate_total=0
        for base_index,base in enumerate(bases):
            current=assembly(base['items'])
            for candidate in current.candidates(roundpart,check_collision=True,check_occlusion=False):
                candidate_total+=1;items=base['items']+[(roundpart,roundcolor,candidate['T'])]
                ev=stable_scorer.score(items,M2)
                if ev:stable.append(dict(items=items,evidence=ev,base_index=base_index))
        stable.sort(key=lambda r:-r['evidence']['score']);complete=[]
        for row in stable[:16]:
            origin=np.asarray(row['evidence']['image_origin']);current=assembly(row['items'])
            poses=[c['T'] for c in current.candidates(pink[0],check_collision=True,check_occlusion=False)]
            contacts=batch_score_insertion_targets(row['items'],pink[0],poses,M2,origin,graph2['arrows']) if poses else []
            for T,contact in zip(poses,contacts):
                fit=pinkfits.get(rotation_key(T))
                if not fit:continue
                shift=origin+M2@T[:3,3]-fit['image_origin'];transverse=abs(float(shift@n));slide=float(shift@d)
                if transverse>4 or slide<0:continue
                score=row['evidence']['score']+.6*fit['score']-.05*transverse+.3*contact.get('score',0.)
                complete.append(dict(items=row['items']+[(*pink,T)],score=score,stable=row['evidence'],detached=fit,
                    transverse=transverse,slide=slide,contact=contact,base_index=row['base_index']))
        complete.sort(key=lambda r:-r['score']);directory=out/roundpart;directory.mkdir(exist_ok=True);results=[]
        for index,row in enumerate(complete[:20]):
            name=f'group_{index:03d}.ldr';write_group(directory/name,row['items'])
            results.append({k:v for k,v in row.items() if k!='items'}|dict(file=name))
        branch=dict(part_choice=choice,shared_inventory_slot=variants[0]['inventory_slot'],slot_capacity=1,
            round_candidates=candidate_total,stable_hypotheses=len(stable),retained_stable=min(16,len(stable)),
            complete_hypotheses=len(complete),results=results,pdf_sha256=audit['pdf_sha256'],truth_used=False,
            runtime_vlm_calls=0,certified=False,other_molds_not_disproved=True,projection=M2.tolist())
        (directory/'results.json').write_text(json.dumps(branch,indent=2));branches.append(dict(directory=str(directory),**{k:v for k,v in branch.items() if k!='results'}))
        print(roundpart,'stable',len(stable),'complete',len(complete),'best',results[0]['score'] if results else None,flush=True)
    report=dict(pdf=str(pdf),pdf_sha256=audit['pdf_sha256'],audit_source=str(audit_path),
        audit_sha256=hashlib.sha256(audit_path.read_bytes()).hexdigest(),source_page=page['page'],
        first_source_xref=ordered[0],second_source_xref=ordered[1],pair_partition=proposal,
        first_pair_hypotheses=len(pairrows),retained_distinct_pairs=len(bases),
        pair_results=[{k:v for k,v in row.items() if k!='items'} for row in bases],
        branches=branches,continuation_edges=audit['continuation_edges'],
        first_arrow_topology=topology1,second_arrow_topology=topology2,
        arrow_halo=dict(first=graph1['halo_evidence'],second=graph2['halo_evidence'],
            largest_pink_region_pixels=int(pink_region.sum()),pink_region_pixels_removed=pink_removed,
            proposed_pink_intersection_pixels=proposed_pink_removed),
        truth_used=False,runtime_vlm_calls=0,part_ids_derived_from_pdf=True,certified=False,
        metric='Optional pastel target / true CAD material labels + native CAD edge; direct exploded constraints',
        limitations=['One shared ambiguous slot is branched, never duplicated or silently fixed.',
            'Stable pair+round component must be inferred correctly; top16 retained per mold.',
            'At most four near-top distinct first pairs; no continuous camera variation.',
            'Group still must attach on following page; no set-placement certificate.'])
    (out/'results.json').write_text(json.dumps(report,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--audit',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.audit,a.out)
