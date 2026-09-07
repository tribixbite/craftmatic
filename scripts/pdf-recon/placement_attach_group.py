"""Attach a PDF-derived rigid subassembly to a PDF-derived current assembly.

Both caches must carry matching PDF provenance. No independent model is read.
Complete-scene scoring retains physical scale while searching camera frames.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np
import pymupdf
sys.path.insert(0,'C:/git/clego')
from recon_v8.assembly import Assembly
from placement_arrow_contacts import read_items
from placement_part_edges import cube_rotations
from vector_scene import scene_images


def make_assembly(items,solid_aliases=None):
    result=Assembly()
    for part,color,T in items:result.add((solid_aliases or {}).get(part,part),color,T)
    return result


def group_transforms(assembly,group,candidate_cache,solids,any_anchor=False):
    seen=set()
    for anchor_index,(part,_,anchor) in enumerate(group if any_anchor else group[:1]):
        if part not in candidate_cache:
            candidate_cache[part]=assembly.candidates(solids.get(part,part),
                kinds=('CYL','CLP','FGR','GEN'),check_collision=True,check_occlusion=False)
        inverse=np.linalg.inv(anchor)
        for candidate in candidate_cache[part]:
            transform=candidate['T']@inverse
            key=tuple(np.round(transform.flatten(),5))
            if key in seen:continue
            seen.add(key)
            yield transform,anchor_index


def run(pdf,base_run,groups,page,out,limit=4,gpu_render=False,camera_mode='row',any_anchor=False,plane_depth=False,copies=1,coarse_pairs=0,coarse_method='surface',target_xref=None,feature_edges=False):
    if out.exists():raise ValueError('Choose a new output directory')
    out.mkdir(parents=True)
    source=out/'source';source.mkdir()
    source_hashes={}
    for path in Path(__file__).parent.glob('*.py'):
        payload=path.read_bytes();(source/path.name).write_bytes(payload)
        source_hashes[path.name]=hashlib.sha256(payload).hexdigest()
    digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
    manifest_path=base_run/'manifest.json'
    if not manifest_path.exists():manifest_path=base_run/'results.json'
    base_manifest=json.loads(manifest_path.read_text())
    group_manifest=json.loads((groups/'results.json').read_text())
    if base_manifest.get('pdf_sha256')!=digest or not base_manifest.get('pdf_only'):
        raise ValueError('Base cache must originate from the same PDF')
    if group_manifest.get('pdf_sha256')!=digest or group_manifest.get('truth_used') is not False:
        raise ValueError('Group cache must originate from this PDF without reference poses')
    if base_manifest.get('runtime_vlm_calls')!=0 or group_manifest.get('runtime_vlm_calls')!=0:
        raise ValueError('Both caches must explicitly attest zero runtime VLM calls')
    if copies not in (1,2):raise ValueError('Only one or two independent group copies supported')
    if copies==2 and group_manifest.get('multiplicity')!=2:
        raise ValueError('Two copies require PDF-derived multiplicity=2 evidence')
    base=read_items(base_run/'model.ldr')
    from placement_group_equivalence import geometry_key
    from placement_part_library import PartLibrary
    library=PartLibrary();geometry_cache={};group_classes={}
    for path in sorted(groups.glob('group_*.ldr')):
        key=geometry_key(read_items(path),library.resolve,geometry_cache)
        group_classes.setdefault(key,[]).append(path)
    paths=[members[0] for members in group_classes.values()][:limit]
    deduplication=dict(protocol='Full colored triangle connectivity, proper cube frames, rounding1e-5 LDU',
        classes=[[str(p) for p in members] for members in group_classes.values()],
        retained_representatives=[str(p) for p in paths],limit=limit)
    (out/'group-equivalence.json').write_text(json.dumps(deduplication,indent=2))
    if not paths:raise ValueError('No PDF-derived group hypotheses')
    from placement_arrow_mask import protected_cad_colors,conservative_components
    part_colors={(p,c) for p,c,T in base}
    for path in paths:part_colors.update((p,c) for p,c,T in read_items(path))
    palette=protected_cad_colors(sorted(part_colors))
    if not palette['complete']:raise ValueError('Cannot protect unknown CAD print colors during arrow removal')
    doc=pymupdf.open(pdf);scenes=scene_images(doc,doc[page])
    if target_xref is None:scene=scenes[0]
    else:
        matching=[s for s in scenes if s['xref']==target_xref]
        if len(matching)!=1:raise ValueError('Target native image is not unique on requested page')
        scene=matching[0]
    graph=conservative_components(scene,protected_colors=palette['rgb'])
    scene=dict(scene,mask=graph['clean_mask'])
    arrow_evidence=dict(candidates=graph['candidates'],palette=palette,
        mask_policy='Whole native scene minus accepted geometric arrow pixels; no component discarded',
        component_areas=[c['area'] for c in graph['components']])
    (out/'arrow-mask.json').write_text(json.dumps(arrow_evidence,indent=2))
    from placement_studs import detect_studs
    from placement_camera import infer_camera_row,infer_camera_robust
    studs=detect_studs(scene['rgb'],scene['mask'])
    camera=infer_camera_row(studs)
    if not camera.get('ok'):camera=infer_camera_robust(studs)
    if camera_mode=='multirow':
        from placement_multirow_camera import row_camera_hypotheses
        camera=row_camera_hypotheses(scene)
        matrices=[np.asarray(h['matrix']) for h in camera['hypotheses']]
    else:matrices=[np.asarray(camera['matrix'])] if camera.get('ok') else []
    if not matrices:raise ValueError('Complete scene camera unresolved')
    (out/'camera.json').write_text(json.dumps(dict(camera,source_page=page,xref=scene['xref'],studs=studs),indent=2))
    if gpu_render:
        if feature_edges:
            from placement_feature_scene_score import PdfFeatureSceneScorer
            scorer=PdfFeatureSceneScorer(scene,plane_depth=plane_depth)
        else:
            from placement_gpu_colored_scene_score import GpuColoredSceneScorer
            scorer=GpuColoredSceneScorer(scene,plane_depth=plane_depth)
    else:
        from placement_colored_scene_score import ColoredSceneScorer
        scorer=ColoredSceneScorer(scene)
    # These are explicit universal solid-geometry aliases; printed IDs and
    # print colors remain intact in scoring and emitted models.
    solids={'3010pb291':'3010'}
    assembly=make_assembly(base,solids)
    candidate_cache={}
    ranked=[];tested=0;legal=0;started=time.time();inputs=[]
    repeated_reports=[]
    projections=[M@R[:3,:3] for M in matrices for R in cube_rotations()]
    for path in paths:
        group=read_items(path)
        inputs.append({'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        if not group:raise ValueError('Empty PDF group')
        placements=[]
        for global_transform,anchor_index in group_transforms(assembly,group,candidate_cache,solids,any_anchor):
            placed=[(p,c,global_transform@T) for p,c,T in group]
            if any(assembly.collides(solids.get(p,p),T) for p,c,T in placed):continue
            legal+=1
            if copies==2:
                placements.append(dict(items=placed,anchor_index=anchor_index))
                continue
            items=base+placed
            for projection in projections:
                result=scorer.score(items,projection)
                tested+=1
                if result.get('bbox_rejected') or not np.isfinite(result['score']):continue
                ranked.append({'items':items,'projection':projection,'evidence':result,
                               'group_source':path.name,'anchor_index':anchor_index})
        if copies==2:
            from placement_repeated_groups import score_repeated_pair
            def progress(value):
                print(json.dumps(dict(group=path.name,**value)),flush=True)
                (out/'progress.json').write_text(json.dumps(dict(group=path.name,**value),indent=2))
            def checkpoint(rows,status):
                data=dict(pdf_sha256=digest,group_source=path.name,partial=True,certified=False,
                    runtime_vlm_calls=0,truth_used=False,status=status,
                    results=[dict(parts=[dict(part=p,color=c,transform=T.tolist()) for p,c,T in row['items']],
                        projection=row['projection'].tolist(),evidence=row['evidence'],
                        placement_indices=row['placement_indices']) for row in rows])
                target=out/f'partial-{path.stem}.json';temporary=target.with_suffix('.json.tmp')
                temporary.write_text(json.dumps(data,indent=2),encoding='utf-8');temporary.replace(target)
            selected,details=score_repeated_pair(base,placements,projections,scorer,
                make_assembly,solids,path.name,progress=progress,
                coarse_limit=coarse_pairs,coarse_method=coarse_method,checkpoint=checkpoint)
            ranked.extend(selected);tested+=details['tested_views']
            repeated_reports.append(dict(group=path.name,candidate_placements=len(placements),**details))
        print(f'group={path.name} legal={legal} views={tested}',flush=True)
    ranked.sort(key=lambda r:-r['evidence']['score'])
    if not ranked:raise ValueError('No compatible complete-scene group placement')
    records=[]
    for index,row in enumerate(ranked[:20]):
        model=make_assembly(row['items']).to_ldr('0 PDF-derived rigid group placement; uncertified')
        (out/f'beam_{index:02d}.ldr').write_text(model,encoding='utf-8')
        if index==0:
            (out/'model.ldr').write_text(model,encoding='utf-8')
            scorer.score(row['items'],row['projection'],renderpath=out/'selected.png')
        records.append({'file':f'beam_{index:02d}.ldr','group_source':row['group_source'],
                        'anchor_index':row['anchor_index'],
                        'projection':row['projection'].tolist(),'evidence':row['evidence']})
    report={'pdf':str(pdf.resolve()),'pdf_sha256':digest,'pdf_only':True,'truth_used':False,
        'runtime_vlm_calls':0,'certified':False,'page':page,'xref':scene['xref'],
        'camera':camera,
        'camera_mode':camera_mode,'gpu_render':gpu_render,'any_anchor':any_anchor,'plane_depth':plane_depth,
        'copies':copies,'repeated_search':repeated_reports,
        'coarse_pairs':coarse_pairs,'coarse_method':coarse_method if coarse_pairs else None,
        'feature_edges':feature_edges,
        'group_equivalence':deduplication,
        'arrow_evidence':arrow_evidence,
        'base_source':str(base_run),'base_sha256':hashlib.sha256((base_run/'model.ldr').read_bytes()).hexdigest(),
        'group_inputs':inputs,'solid_geometry_aliases':solids,'legal_groups':legal,'tested_views':tested,
        'seconds':time.time()-started,'selected_parts':len(ranked[0]['items']),'results':records,
        'code_sha256_start':source_hashes,
        'code_sha256_end':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')},
        'geometry_dependencies':{str(key):value['files'] for key,value in scorer.geometry.items()},
        'limitations':['Rigid group attachment through enumerated connector mates','Approximate complete-scene rendering',
                      'No full-model or population certification']+
                      (['Repeated copies each require a direct mate to the pre-existing base'] if copies==2 else [])+
                      (['Heuristic complete-pair screening may discard the globally best detailed-render candidate'] if coarse_pairs else [])}
    (out/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('pdf',type=Path)
    parser.add_argument('--base-run',type=Path,required=True)
    parser.add_argument('--groups',type=Path,required=True)
    parser.add_argument('--page',type=int,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--limit',type=int,default=4)
    parser.add_argument('--gpu-render',action='store_true')
    parser.add_argument('--camera-mode',choices=['row','multirow'],default='row')
    parser.add_argument('--any-anchor',action='store_true')
    parser.add_argument('--plane-depth',action='store_true')
    parser.add_argument('--copies',type=int,choices=[1,2],default=1)
    parser.add_argument('--coarse-pairs',type=int,default=0)
    parser.add_argument('--coarse-method',choices=['surface','layers'],default='surface')
    parser.add_argument('--target-xref',type=int)
    parser.add_argument('--feature-edges',action='store_true')
    args=parser.parse_args()
    run(args.pdf,args.base_run,args.groups,args.page,args.out,args.limit,args.gpu_render,args.camera_mode,args.any_anchor,args.plane_depth,args.copies,args.coarse_pairs,args.coarse_method,args.target_xref,args.feature_edges)
