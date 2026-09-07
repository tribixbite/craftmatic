"""PDF-native assembly beam experiment, with no runtime VLM or pose input."""
import argparse
from collections import Counter
import hashlib
import itertools
import json
from pathlib import Path
import sys
import time
import numpy as np
import pymupdf

sys.path.insert(0,'C:/git/clego')
from recon_extract import pdf_inventory as bom, extract_e4 as e4
from recon_v3.common import get_part_dims
from recon_v7.partnames import is_nonbuildable
from recon_v8.assembly import Assembly
from frozen_pdf_matcher import FrozenPdfMatcher
from global_pdf_assignment import assign
from placement_gpu_render import SurfaceScorer
from vector_scene import scene_images
from vector_scene_components import component_graph

BASE=Path('C:/git/clego')


def rotations():
    out=[]
    for permutation in itertools.permutations(range(3)):
        for signs in itertools.product((-1,1),repeat=3):
            R=np.eye(3)[:,permutation]*signs
            if np.linalg.det(R)>.99:
                T=np.eye(4);T[:3,:3]=R;out.append(T)
    return out


def assembly(items):
    a=Assembly()
    for part,color,T in items:a.add(part,color,T)
    return a


def connected_target(scene):
    """Remove red instruction arrows, then retain the largest object component.

    This is only an initial scene-graph heuristic. Detached additions and inset
    assembly multiplicities must stay explicit in the evidence, never ignored
    as a declaration that reconstruction is complete.
    """
    graph=component_graph(scene)
    if not graph['components']:raise ValueError('No arrow-separated scene component')
    return graph['components'][0]['mask']


def target_for(doc,page,include_scene=False):
    scenes=scene_images(doc,doc[page])
    if not scenes:raise ValueError(f'No native scene on page {page}')
    selected=scenes[0];source=page
    # An exploded page may show its assembled result in the next page's
    # stable main component. This bounded lookahead reads PDF pixels only.
    if selected['red_arrow_fraction']>.002 and page+1<len(doc):
        next_scenes=scene_images(doc,doc[page+1])
        if next_scenes:
            selected=next_scenes[0];source=page+1
    mask=connected_target(selected)
    from placement_studs import detect_studs
    evidence={'source_page':source,'xref':selected['xref'],
        'bbox':selected['bbox'],'red_arrow_fraction':selected['red_arrow_fraction'],
        'stud_detections':detect_studs(selected['rgb'],mask),
        'method':'native scene largest component; bounded one-page lookahead'}
    return (mask,evidence,selected) if include_scene else (mask,evidence)


def registrations(scene,mask,items,projection,out):
    from placement_registration import locate_part
    groups=[]
    for part,color,T in items[:2]:
        groups.append(locate_part(dict(scene,mask=mask),part,color,T,projection,out))
    proposals=[]
    for group in groups:
        for proposal in group:
            origin=np.asarray(proposal['image_origin'])
            agreement=sum(max((p['score']*np.exp(-np.linalg.norm(origin-np.asarray(p['image_origin']))**2/18)
                               for p in options),default=0.) for options in groups)
            proposals.append({'image_origin':origin.tolist(),'agreement':float(agreement)})
    proposals.sort(key=lambda p:-p['agreement'])
    selected=[]
    for proposal in proposals:
        if any(np.linalg.norm(np.asarray(proposal['image_origin'])-p['image_origin'])<2 for p in selected):continue
        selected.append(proposal)
        if len(selected)>=5:break
    return selected


def run(pdf,out,beam_width=12,max_pages=0,device='cuda',pair_seeds=0,per_seed=2,
        pdf_camera=False,pair_edges=False,stud_weight=0.,joint_pairs=False,max_frontier=6000,
        fixed_registration=False,unknown_colors=False,view_registration=False,parts_list=None,exploded_steps=False,arrow_contacts=0.):
    import cv2
    pdf=pdf.resolve();out=out.resolve()
    if out.exists():raise ValueError('Choose a new run directory')
    out.mkdir(parents=True)
    source_dir=out/'source'
    source_dir.mkdir()
    source_hashes={}
    for source in Path(__file__).parent.glob('*.py'):
        payload=source.read_bytes()
        (source_dir/source.name).write_bytes(payload)
        source_hashes[source.name]=hashlib.sha256(payload).hexdigest()
    manifest={'pdf':str(pdf),'pdf_sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),
        'pdf_only':True,'runtime_vlm_calls':0,'certified':False,'beam_width':beam_width,
        'device':device,'started':time.time(),'status':'running','code_sha256_start':source_hashes,
        'pair_seeds':pair_seeds,'per_seed':per_seed,
        'pdf_camera':pdf_camera,'pair_edges':pair_edges,
        'stud_weight':stud_weight,
        'joint_pairs':joint_pairs,'max_frontier':max_frontier,
        'fixed_registration':fixed_registration,
        'unknown_colors':unknown_colors,
        'view_registration':view_registration,
        'exploded_steps':exploded_steps,
        'arrow_contact_weight':arrow_contacts,
        'limitations':['Experimental surface renderer','Heuristic scene graph and lookahead',
                      'No atomic subassembly placement','No population accuracy established']}
    def save(name,value):
        (out/name).write_text(json.dumps(value,indent=2),encoding='utf-8')
    # Guard every historical VLM entry point even though none is used here.
    from recon_v7 import vlm
    original={name:getattr(vlm,name) for name in ('ask','ask_json','_post')}
    def forbidden(*args,**kwargs):raise RuntimeError('Runtime VLM forbidden')
    for name in original:setattr(vlm,name,forbidden)
    try:
        with pymupdf.open(pdf) as doc:
            data=BASE/'extracted/studio_earlyaccess/app/data'
            catalog=bom.bridge_catalog(bom.load_studio_catalog(data),bom.load_catalog(BASE/'elements.csv'))
            if parts_list is not None:
                from placement_parts_list import load_parts_list
                inventory=load_parts_list(parts_list)
                manifest['optional_parts_list']={k:inventory[k] for k in ('source','sha256','scope')}
            else:inventory=bom.extract(doc,catalog,namespace='ldraw')
            save('inventory.json',inventory)
            counts=Counter()
            for record in inventory['records']:
                if 'part' in record and not is_nonbuildable(record['part']):
                    counts[(int(record['color']),record['part'],*map(int,get_part_dims(record['part'])))]+=record['qty']
            rows=[list(key)+[qty] for key,qty in counts.items()]
            matcher=FrozenPdfMatcher(doc)
            # This first experiment is explicitly limited to supported Era-4.
            allocations,report=assign(doc,e4.ERA4,rows,matcher,out)
            camera=None
            if pdf_camera:
                from placement_pdf_camera import camera_for
                camera=camera_for(doc,min(allocations))
                save('camera.json',camera)
                if camera['matrix'] is None:raise ValueError('PDF camera unresolved')
            projection=camera['matrix'] if camera else None
            scorer=SurfaceScorer(device=device,projection=projection,stud_weight=stud_weight)
            states=[{'items':[],'history_score':0.,'family':0}]
            journal=[];pages=sorted(allocations)
            if max_pages:pages=pages[:max_pages]
            for page in pages:
                mask,evidence,scene=target_for(doc,page,include_scene=True)
                cv2.imwrite(str(out/f'target_{page:03d}.png'),(scorer.scene(mask,evidence['stud_detections'])*255).astype(np.uint8))
                additions=[(str(rows[a['index']][1]),int(rows[a['index']][0]))
                           for a in allocations[page] for _ in range(a['qty'])]
                unknown=None
                if unknown_colors:
                    from placement_unknown_regions import unknown_regions, filter_unknown_studs
                    allowed={c for _,c,_ in states[0]['items']}|{c for _,c in additions}
                    unknown,unknown_evidence=unknown_regions(scene['rgb'],mask,allowed)
                    evidence['stud_detections'],stud_evidence=filter_unknown_studs(evidence['stud_detections'],unknown)
                    evidence['unknown_regions']=dict(unknown_evidence,stud_filter=stud_evidence)
                    cv2.imwrite(str(out/f'unknown_{page:03d}.png'),unknown.astype(np.uint8)*255)
                    scorer.scene(mask,evidence['stud_detections'],unknown=unknown)
                steps=[]
                if pair_seeds and not states[0]['items'] and len(additions)>=2:
                    from placement_exploded_pair import propose
                    proposals=propose(doc,page,*additions[:2],rotations(),device=device,limit=pair_seeds,
                                      projection=projection,edge_cache=out/'part-render-cache' if pair_edges else None)
                    if proposals:
                        states=[dict(p,family=i) for i,p in enumerate(proposals)]
                        steps.append({'method':'exploded pair bootstrap','families':len(states)})
                        save('pair-bootstrap.json',[{'family':s['family'],'score':s['score'],'evidence':s['evidence']}
                                                    for s in states])
                        additions=additions[2:]
                        scorer.scene(mask,evidence['stud_detections'],unknown=unknown)
                origins=[]
                exploded=None
                if (exploded_steps and len(states[0]['items'])==4 and len(additions)==2
                        and additions[0]==additions[1] and additions[0][1]==15
                        and all(c==15 for _,c,_ in states[0]['items'])):
                    from placement_exploded_step import ExplodedStepScorer
                    own_scenes=scene_images(doc,doc[page])
                    exploded=ExplodedStepScorer(own_scenes[0],projection,states[0]['items'][:2],out/'exploded-step-cache',contact_weight=arrow_contacts)
                    evidence['direct_exploded_step']={'source_page':page,'xref':own_scenes[0]['xref'],
                        'method':'Joint intermediate main assembly and detached last addition',
                        'origins':[o.tolist() for o in exploded.origins],
                        'scope':'Bounded white two-addition step after four-piece bootstrap'}
                if fixed_registration:
                    if projection is None or not states[0]['items']:raise ValueError('Fixed registration requires calibrated pair bootstrap')
                    if view_registration and page!=pages[0]:
                        from placement_view_registration import register_views
                        views=register_views(dict(scene,mask=mask),states[0]['items'][:2],projection,out/'view-registration-cache')
                        evidence['view_hypotheses']=views
                        origins=[dict(image_origin=o['image_origin'],agreement=o['score'],projection=v['projection'])
                                 for v in views for o in v['origins']]
                    else:origins=registrations(scene,mask,states[0]['items'],projection,out/'registration-cache')
                    if not origins:raise ValueError('No scene registration hypothesis')
                    evidence['registrations']=origins
                for addition_index,(part,color) in enumerate(additions):
                    defer=joint_pairs and len(additions)==2 and addition_index==0
                    expanded=[]
                    for state in states:
                        items=state['items']
                        if not items:
                            # Do not prune the arbitrary initial coordinate gauge.
                            expanded.extend({'items':[(part,color,T)],'history_score':0.,'score':0.,'family':0}
                                            for T in rotations())
                            continue
                        a=assembly(items)
                        candidates=a.candidates(part,kinds=('CYL','CLP','FGR','GEN'),
                            check_collision=False,check_occlusion=False)
                        if not candidates:continue
                        transforms=[c['T'] for c in candidates]
                        if defer:
                            for T in transforms:
                                if a.collides(part,T):continue
                                expanded.append({'items':items+[(part,color,T)],'score':state['score'],
                                    'history_score':state['history_score'],'family':state['family']})
                            if len(expanded)>max_frontier:
                                raise RuntimeError('Joint frontier limit exceeded; no silent greedy pruning permitted')
                            continue
                        if exploded is not None:
                            details=exploded.batchscore(items,part,color,transforms)
                            scores=np.array([d['score'] for d in details])
                        elif origins:
                            alternatives=[]
                            for origin in origins:
                                if 'projection' in origin:
                                    import torch
                                    scorer.matrix=torch.tensor(origin['projection'],dtype=torch.float32,device=scorer.device)
                                scorer.registration=origin['image_origin']
                                alternatives.append(scorer.score(items,part,transforms)+.03*origin['agreement'])
                            scores=np.max(alternatives,axis=0)
                        else:scores=scorer.score(items,part,transforms)
                        # Image-score ALL raw mates before collision filtering.
                        kept=0
                        for index in np.argsort(-scores,kind='stable'):
                            T=transforms[index]
                            if a.collides(part,T):continue
                            expanded.append({'items':items+[(part,color,T)],
                                'score':float(scores[index]),'history_score':state['history_score'],
                                'family':state['family']})
                            kept+=1
                            if kept>=beam_width:break
                    if not expanded:
                        raise RuntimeError(f'No surviving assembly for page {page}, part {part}')
                    if defer or len(expanded[0]['items'])==1:
                        states=expanded
                    else:
                        expanded.sort(key=lambda s:-(s['score']+.1*s['history_score']))
                        states=[];seen=set();family_counts=Counter()
                        for state in expanded:
                            if pair_seeds and family_counts[state['family']]>=per_seed:continue
                            key=tuple((p,c,tuple(np.round(T.flatten(),3))) for p,c,T in state['items'])
                            if key in seen:continue
                            seen.add(key);states.append(state)
                            family_counts[state['family']]+=1
                            if len(states)>=(pair_seeds*per_seed if pair_seeds else beam_width):break
                    steps.append({'part':part,'color':color,'hypotheses':len(states),'score':states[0]['score']})
                    print(f'page={page} pieces={len(states[0]["items"])} beams={len(states)} score={states[0]["score"]:.4f}',flush=True)
                for state in states:state['history_score']+=state['score']
                best=states[0]
                (out/'model.ldr').write_text(assembly(best['items']).to_ldr('0 PDF native scene beam research; uncertified'),encoding='utf-8')
                journal.append({'page':page,'target':evidence,'steps':steps,'placed':len(best['items'])})
                save('journal.json',journal)
                snapshot=out/f'page_{page:03d}_beams'
                snapshot.mkdir(exist_ok=True)
                for i,state in enumerate(states):
                    (snapshot/f'beam_{i:02d}.ldr').write_text(assembly(state['items']).to_ldr(),encoding='utf-8')
            for i,state in enumerate(states):
                (out/f'beam_{i:02d}.ldr').write_text(assembly(state['items']).to_ldr(),encoding='utf-8')
            manifest.update(status='complete_approximate',placed=len(states[0]['items']),
                pages=len(pages),rendered_hypotheses=scorer.hypotheses,render_calls=scorer.calls,
                checkpoint_sha256=hashlib.sha256(matcher.checkpoint_path.read_bytes()).hexdigest())
    except Exception as error:
        manifest.update(status='failed',error=f'{type(error).__name__}: {error}')
        raise
    finally:
        for name,value in original.items():setattr(vlm,name,value)
        manifest['finished']=time.time()
        manifest['code_sha256']={p.name:hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in Path(__file__).parent.glob('*.py')}
        manifest['source_changed_during_run']=[name for name,digest in source_hashes.items()
                                             if manifest['code_sha256'].get(name)!=digest]
        save('manifest.json',manifest)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('pdf',type=Path)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--beam',type=int,default=12)
    parser.add_argument('--max-pages',type=int,default=0)
    parser.add_argument('--device',choices=['cpu','cuda'],default='cuda')
    parser.add_argument('--pair-seeds',type=int,default=0)
    parser.add_argument('--per-seed',type=int,default=2)
    parser.add_argument('--pdf-camera',action='store_true')
    parser.add_argument('--pair-edges',action='store_true')
    parser.add_argument('--stud-weight',type=float,default=0.)
    parser.add_argument('--joint-pairs',action='store_true')
    parser.add_argument('--max-frontier',type=int,default=6000)
    parser.add_argument('--fixed-registration',action='store_true')
    parser.add_argument('--unknown-colors',action='store_true')
    parser.add_argument('--view-registration',action='store_true')
    parser.add_argument('--parts-list',type=Path,help='Optional JSON records containing only part, color, qty; no pose data')
    parser.add_argument('--exploded-steps',action='store_true')
    parser.add_argument('--arrow-contacts',type=float,default=0.)
    args=parser.parse_args()
    if args.beam<1:parser.error('--beam must be positive')
    if args.pair_seeds<0 or args.per_seed<1:parser.error('Invalid family retention settings')
    if args.exploded_steps and not (args.joint_pairs and args.pdf_camera):
        parser.error('--exploded-steps requires --joint-pairs and --pdf-camera')
    run(args.pdf,args.out,args.beam,args.max_pages,args.device,args.pair_seeds,args.per_seed,
        args.pdf_camera,args.pair_edges,args.stud_weight,args.joint_pairs,args.max_frontier,args.fixed_registration,args.unknown_colors,args.view_registration,args.parts_list,args.exploded_steps,args.arrow_contacts)
