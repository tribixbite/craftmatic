"""Generic exploded pair search using only bound automatic PDF allocations."""
import argparse,hashlib,json
from pathlib import Path
import cv2,numpy as np,pymupdf
from placement_pdf_group_evidence import extract
from placement_beam import assembly,rotations
from placement_gpu_colored_scene_score import GpuColoredSceneScorer
from placement_part_edges import canonical,features,compare
from placement_colored_cad import _rgb
from vector_scene import scene_images
from vector_scene_components import component_graph
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_pair_topology import arrow_pair_components


def run(pdf,page,allocation_run,out,camera_file=None,feature_edges=False,arrow_halo=False,insertion_contacts=False):
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')}
    evidence=extract(pdf,page,allocation_run,out/'evidence',refine_halo=arrow_halo)
    groups=evidence['pair_groups']
    if len(groups)!=1:raise ValueError('Exactly one unambiguous allocated repeated pair required')
    group=groups[0];parts=[(p,int(c)) for p,c in group['parts']]
    palette=protected_cad_colors(parts)
    if not palette['complete']:raise ValueError('Cannot protect missing CAD print palette')
    if group['kind']!='exploded_pair':raise ValueError('Completed pair dispatch not yet implemented in this generic runner')
    with pymupdf.open(pdf) as doc:scene=next(s for s in scene_images(doc,doc[page]) if s['xref']==group['source_xref'])
    camera=next(s['camera'] for s in evidence['scenes'] if s['xref']==group['source_xref'])
    graph=conservative_components(scene,protected_colors=palette['rgb'])
    if arrow_halo:
        from placement_arrow_halo import refine_arrow_halo
        graph=refine_arrow_halo(scene,graph,palette['rgb'])
    if camera_file:
        camera=json.loads(camera_file.read_text())
        if camera.get('pdf_sha256')!=evidence['pdf_sha256'] or camera.get('source_page')!=page or camera.get('source_xref')!=group['source_xref'] or camera.get('allocation_sha256')!=evidence['allocation_sha256'] or camera.get('truth_used') is not False or camera.get('runtime_vlm_calls')!=0:
            raise ValueError('Camera cache provenance does not match this PDF allocation and native inset')
    elif not camera.get('ok'):
        from placement_cad_camera_fit import infer_cad_pair_camera
        camera=infer_cad_pair_camera(scene,graph,parts)
    if not camera['ok']:raise ValueError('Inset camera unresolved')
    M=np.asarray(camera['matrix']);components,topology=arrow_pair_components(graph);arrows=graph['arrows']
    direction=np.mean([np.asarray(a['direction'])/np.linalg.norm(a['direction']) for a in arrows],axis=0);direction/=np.linalg.norm(direction);normal=np.array([-direction[1],direction[0]])
    rootcomponent=int(np.argmax([((np.asarray(c['bbox'][:2])+c['bbox'][2:])/2)@direction for c in components]));movingcomponent=1-rootcomponent
    Rlist=rotations();key=lambda T:tuple(np.round(T[:3,:3].ravel(),5));cached={}
    for ci,component in enumerate(components):
        current=dict(scene,mask=component['mask'])
        if feature_edges:
            from placement_feature_edges import FeatureEdgeScorer
            scorer=FeatureEdgeScorer(current)
        else:scorer=GpuColoredSceneScorer(current)
        target=features(*canonical(current['rgb'],current['mask']))
        for part,color in parts:
            for ri,R in enumerate(Rlist):
                ev=scorer.score([(part,color,R)],M)
                if ev.get('bbox_rejected'):continue
                edge,_=compare(features(*canonical(scorer.last_outline if feature_edges else scorer.last_rgb,scorer.last_mask)),target)
                cached[(ci,part,key(R))]=dict(origin=np.asarray(ev['image_origin']),edge=float(edge),balanced=ev['score'])
    rows=[];tested=0
    # Either allocated identity may be the arrow recipient; no allocation-order prior.
    for first,second in (parts,parts[::-1]):
        for R in Rlist:
            p,c=first;q,d=second;rootfit=cached.get((rootcomponent,p,key(R)))
            if rootfit is None:continue
            base=assembly([(p,c,R)])
            mates=base.candidates(q,kinds=('CYL','CLP','FGR','GEN'),check_collision=True,check_occlusion=False)
            if insertion_contacts:
                from placement_arrow_contacts import batch_score_insertion_targets
                contacts=batch_score_insertion_targets([(p,c,R)],q,np.asarray([m['T'] for m in mates]),M,rootfit['origin'],arrows)
            else:contacts=[None]*len(mates)
            for mate,contact in zip(mates,contacts):
                tested+=1;T=mate['T'];movingfit=cached.get((movingcomponent,q,key(T)))
                if insertion_contacts and not contact.get('supported'):continue
                if movingfit is None:continue
                displacement=rootfit['origin']+M@T[:3,3]-movingfit['origin'];transverse=abs(float(displacement@normal));slide=float(displacement@direction)
                if transverse>3 or slide<0:continue
                edge=(rootfit['edge']+movingfit['edge'])/2;balanced=(rootfit['balanced']+movingfit['balanced'])/2
                image_score=.5*(edge+balanced)-.05*transverse
                final_score=.8*image_score+.2*contact['score'] if insertion_contacts else image_score
                rows.append(dict(items=[(p,c,R),(q,d,T)],score=final_score,image_score=image_score,edge=edge,balanced=balanced,transverse_px=transverse,arrow_slide_px=slide,insertion_evidence=contact))
    rows.sort(key=lambda r:-r['score']);records=[]
    for index,row in enumerate(rows[:20]):
        name=f'group_{index:03d}.ldr';(out/name).write_text(assembly(row['items']).to_ldr('0 Automatic PDF allocated repeated pair; uncertified'))
        records.append({k:v for k,v in row.items() if k!='items'}|dict(file=name,parts=[(p,c) for p,c,T in row['items']],transforms=[T.tolist() for p,c,T in row['items']]))
    result=dict(pdf=str(pdf.resolve()),pdf_sha256=evidence['pdf_sha256'],source_page=page,source_xref=group['source_xref'],parts=parts,group_anchor_index=0,
        repetition=group['multiplier'],multiplicity=group['multiplier'],repetition_evidence=group['repetition_evidence'],allocation_file=evidence['allocation_file'],allocation_sha256=evidence['allocation_sha256'],
        part_ids_derived_from_pdf=True,truth_used=False,runtime_vlm_calls=0,certified=False,projection=M.tolist(),camera=camera,code_sha256_start=hashes,
        candidate_count=tested,retained_count=len(rows),results=records,arrow_topology=topology,protected_cad_palette=palette,feature_edges=feature_edges,arrow_halo=arrow_halo,insertion_contacts=insertion_contacts,halo_evidence=graph.get('halo_evidence'),limitations=['Repeated pair must be placed separately for each instance','Exact frame yaw may remain unobservable','No reference poses used; no full-set certification'])
    (out/'results.json').write_text(json.dumps(result,indent=2));print('COMPLETE',tested,len(rows),records[:1])


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('pdf',type=Path);parser.add_argument('--page',type=int,required=True);parser.add_argument('--allocation-run',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);parser.add_argument('--camera-file',type=Path);parser.add_argument('--feature-edges',action='store_true');parser.add_argument('--arrow-halo',action='store_true');parser.add_argument('--insertion-contacts',action='store_true')
    a=parser.parse_args();run(a.pdf,a.page,a.allocation_run,a.out,a.camera_file,a.feature_edges,a.arrow_halo,a.insertion_contacts)
