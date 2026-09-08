"""Connect fixed-camera occupancy screening, GPU bank, and joint quota search.

Development runner: bounded candidate closure/registration is uncertified.
No reference poses or runtime VLM. Saved results retain every limitation.
"""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
from placement_arrow_contacts import read_items
from placement_attach_group import make_assembly
from placement_mixed_batch import color_bank
from placement_cardinality_bank import build_bank
from placement_cardinality_search import search_layers
from placement_occupancy_screen import screen
from placement_material_scene_score import MaterialFeatureSceneScorer


def fixed_native_score(scorer,items,M,origin,renderpath=None):
    M=np.asarray(M,float);origin=np.asarray(origin,float);lows=[];highs=[]
    for p,c,T in items:
        projected=scorer._project_part(p,c,T,M);offset=M@T[:3,3]
        lows.append(projected['lo']+offset);highs.append(projected['hi']+offset)
    old_center=scorer.target_center.copy();old_tolerance=scorer.span_tolerance
    try:
        scorer.target_center=origin+(np.min(lows,0)+np.max(highs,0))/2
        scorer.span_tolerance=float('inf');evidence=scorer.score(items,M,renderpath)
    finally:scorer.target_center=old_center;scorer.span_tolerance=old_tolerance
    if not np.allclose(evidence['image_origin'],origin,atol=1e-10,rtol=0):raise AssertionError('Native registration origin changed')
    evidence['registration_protocol']='Fixed PDF-derived camera and native origin; no candidate bbox recentering'
    return evidence


def run(record,registration,scene,base,out,views=3,scale=1.,max_nodes=100000,top_k=32):
    scorer=MaterialFeatureSceneScorer(scene,plane_depth=True);part=record['part'];results=[];native=[]
    shapes=[dict(items=[(part,15,np.asarray(T))]) for T in record['poses']]
    for vi,view in enumerate(registration['hypotheses'][:views]):
        M=np.asarray(view['projection']);origin=np.asarray(view['origin']);gate=screen(base,shapes,M,origin,scorer)
        (out/f'view-{vi:02}-occupancy.json').write_text(json.dumps(gate,indent=2))
        if not gate['registration_consistent']:
            results.append(dict(view=vi,status='base_registration_rejected',base_occupancy=gate['base']));continue
        ids=gate['retained_indices'];subset=dict(record,poses=[record['poses'][i] for i in ids]);placements,quotas=color_bank(subset,record['allocated_pieces'])
        if not placements:results.append(dict(view=vi,status='no_occupancy_compatible_candidates'));continue
        try:bank=build_bank(base,placements,M,origin,scorer,scale=scale)
        except ValueError as exc:
            if 'Bank requires' not in str(exc):raise
            results.append(dict(view=vi,status='host_bank_budget_exceeded',reason=str(exc),occupancy_retained_shapes=len(ids)))
            continue
        original=[ids[p['pose_index']] for p in placements];colors=[p['color'] for p in placements]
        anchored=[i for i,p in enumerate(original) if p in record['base_supported']]
        witnesses={tuple(edge) for edge in record['support_edges']};support=[]
        for i in range(len(placements)):
            for j in range(i):
                if tuple(sorted((original[i],original[j]))) in witnesses:support.append((j,i))
        physical={};collision_cache={}
        def conflict(i,j):
            a,b=sorted((original[i],original[j]));key=(a,b)
            if key not in collision_cache:
                if a==b:collision_cache[key]=True
                else:
                    if a not in physical:physical[a]=make_assembly(shapes[a]['items'])
                    collision_cache[key]=bool(physical[a].collides(part,np.asarray(record['poses'][b])))
            return collision_cache[key]
        # Single-layer target agreement changes traversal only; no candidate
        # is removed by this incomplete-state score.
        priorities=[float(np.sum((bank['labels'][i]==bank['target'])&(bank['target']>0))) for i in range(len(placements))]
        result=search_layers(bank['base_depth'],bank['base_labels'],bank['depths'],bank['labels'],colors,quotas,bank['target'],base_supported=anchored,support_edges=support,max_nodes=max_nodes,conflict_test=conflict,priorities=priorities,top_k=top_k)
        result.update(view=vi,status='bounded_search',bank_metadata=bank['metadata'],occupancy_retained_shapes=len(ids),collision_pairs_tested=len(collision_cache))
        for candidate in result['candidates']:
            items=base+[item for i in candidate['indices'] for item in placements[i]['items']]
            evidence=fixed_native_score(scorer,items,M,origin)
            lines=['0 Quarantined PDF mixed batch; uncertified bounded search']
            for p,c,T in items:lines.append('1 '+str(c)+' '+' '.join(f'{v:.8g}' for v in np.r_[T[:3,3],T[:3,:3].flatten()])+' '+p+'.dat')
            native.append(dict(view=vi,projection=M.tolist(),origin=origin.tolist(),coarse=candidate,evidence=evidence,model='\n'.join(lines)+'\n',_items=items))
        results.append(result)
    native.sort(key=lambda r:-r['evidence']['score'])
    for index,row in enumerate(native):
        model=row.pop('model');items=row.pop('_items');row['file']=f'beam_{index:02}.ldr';(out/row['file']).write_text(model)
        if index==0:
            (out/'model.ldr').write_text(model)
            check=fixed_native_score(scorer,items,row['projection'],row['origin'],out/'selected.png')
            if check!=row['evidence']:raise AssertionError('Selected native PNG render evidence changed')
    dependencies={}
    for parsed in scorer.geometry.values():dependencies.update(parsed.get('files',{}))
    return dict(status='candidates' if native else 'no_models',views=results,results=native,pdf_only=True,base_source=record['base_source'],base_sha256=record['base_sha256'],geometry_dependencies=dependencies,selected_parts=len(base)+len(record['allocated_pieces']) if native else None,page=record['page'],xref=registration['xref'],truth_used=False,runtime_vlm_calls=0,certified=False,limitations='Finite registered candidate bank; occupancy conditional on image tolerance; bounded closure support graph may omit legal edges; finite node budget and optional coarse raster lose optimality guarantees outside searched representation. Only retained complete assemblies receive native reranking.')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--registry',type=Path,required=True);p.add_argument('--registration',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--views',type=int,default=3);p.add_argument('--scale',type=float,default=1.);p.add_argument('--max-nodes',type=int,default=100000);p.add_argument('--top-k',type=int,default=32);a=p.parse_args()
    record=json.loads(a.registry.read_text());registration=json.loads(a.registration.read_text());basepath=Path(record['base_source'])
    for value in (record,registration):
        if value.get('truth_used') is not False or value.get('runtime_vlm_calls')!=0:raise ValueError('Runtime provenance missing')
    if registration['base_sha256']!=record['base_sha256'] or hashlib.sha256(basepath.read_bytes()).hexdigest()!=record['base_sha256']:raise ValueError('Registration/body mismatch')
    if registration['pdf_sha256']!=record['pdf_sha256'] or registration['page']!=record['page']:raise ValueError('PDF page mismatch')
    if hashlib.sha256(Path(record['pdf']).read_bytes()).hexdigest()!=record['pdf_sha256']:raise ValueError('Actual PDF file hash mismatch')
    import pymupdf
    from vector_scene import scene_images
    with pymupdf.open(record['pdf']) as doc:scene=next(s for s in scene_images(doc,doc[record['page']]) if s['xref']==registration['xref'])
    a.out.mkdir(parents=True,exist_ok=False);snapshot=a.out/'source';snapshot.mkdir();hashes={}
    for path in Path(__file__).parent.glob('*.py'):
        payload=path.read_bytes();(snapshot/path.name).write_bytes(payload);hashes[path.name]=hashlib.sha256(payload).hexdigest()
    result=run(record,registration,scene,read_items(basepath),a.out,a.views,a.scale,a.max_nodes,a.top_k)
    result.update(pdf=record['pdf'],pdf_sha256=record['pdf_sha256'],registry_sha256=hashlib.sha256(a.registry.read_bytes()).hexdigest(),registration_sha256=hashlib.sha256(a.registration.read_bytes()).hexdigest(),code_sha256_start=hashes)
    (a.out/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
