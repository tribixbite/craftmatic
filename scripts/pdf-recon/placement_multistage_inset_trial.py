"""Bounded allocation-partition / complete-stage CAD search from PDF layout.

No injected part IDs or poses. The first-stage size is an explicit search
hypothesis, not a claim that layout text provides the number of visible parts.
"""
import argparse
from collections import Counter
import hashlib
import heapq
import itertools
import json
from pathlib import Path
import re
import numpy as np
import pymupdf
from placement_step_graph import extract_layout,layout_graph
from placement_pdf_group_evidence import load_allocations
from placement_multirow_camera import row_camera_hypotheses
from placement_camera import infer_camera_robust
from placement_studs import detect_studs
from placement_beam import assembly,rotations
from placement_gpu_colored_scene_score import GpuColoredSceneScorer
from placement_colored_cad import colored_triangles,_rgb
from placement_part_library import PartLibrary
from placement_layer_pair_screen import classify
from placement_repeated_groups import projected_bounds
from vector_scene import scene_images


def partitions(pieces,size):
    counts=Counter(pieces);keys=sorted(counts)
    return [[key for key,n in zip(keys,values) for _ in range(n)]
        for values in itertools.product(*(range(counts[k]+1) for k in keys)) if sum(values)==size]


def solid_equivalent(part,color,library):
    match=re.match(r'^(\d+[a-z]?)(?:p[a-z].*)$',part)
    if not match:return part,None
    base=match.group(1)
    try:
        printed=colored_triangles(part,color,resolver=library.resolve)
        plain=colored_triangles(base,color,resolver=library.resolve)
    except FileNotFoundError:return part,None
    a=printed['triangles'].reshape(-1,3);b=plain['triangles'].reshape(-1,3)
    error=max(np.max(abs(a.min(0)-b.min(0))),np.max(abs(a.max(0)-b.max(0))))
    if error>1.:return part,None
    return base,dict(part=part,solid=base,bounds_max_error=float(error),
        rationale='Universal printed suffix and matching full geometric bounds; connector surrogate only',
        files={**printed['files'],**plain['files']})


def cameras(scenes):
    result={}
    for scene in scenes:
        row=row_camera_hypotheses(scene)
        robust=infer_camera_robust(detect_studs(scene['rgb'],scene['mask']))
        if row['hypotheses']:result[scene['xref']]=dict(matrix=row['hypotheses'][0]['matrix'],method='native stud-row',source_xref=scene['xref'])
        elif robust.get('ok'):result[scene['xref']]=dict(matrix=robust['matrix'],method='native robust stud grid',source_xref=scene['xref'])
    for scene in scenes:
        if scene['xref'] in result:continue
        peers=[s for s in scenes if s['xref'] in result]
        if not peers:continue
        peer=peers[0];source=result[peer['xref']]
        # Adjacent numbered inset stages share a panel, but camera transfer
        # is only a hypothesis and is tested against complete-stage geometry.
        def image_to_pdf(s):
            a,b,c,d,e,f=s['transform'];h,w=s['rgb'].shape[:2]
            return np.array([[a/w,c/h],[b/w,d/h]])
        transform=np.linalg.inv(image_to_pdf(scene))@image_to_pdf(peer)
        result[scene['xref']]=dict(matrix=(transform@np.asarray(source['matrix'])).tolist(),
            method='same-panel peer camera transfer hypothesis',source_xref=peer['xref'],
            native_pixel_transform=transform.tolist(),certified=False)
    return result


def run(pdf,page,allocation_run,out,stage_size=3,keep=20):
    out.mkdir(parents=True,exist_ok=True);pieces,provenance=load_allocations(pdf,page,allocation_run)
    assignment=json.loads((allocation_run/'global-assignment.json').read_text());library=PartLibrary()
    with pymupdf.open(pdf) as doc:
        graph=layout_graph(extract_layout(doc,page,assignment))
        groups=[g for g in graph['groups'] if len(g.get('sequence',[]))>1]
        if len(groups)!=1:raise ValueError('Exactly one numbered multistage group required')
        group=groups[0];allscenes=scene_images(doc,doc[page]);scenes=[next(s for s in allscenes if s['xref']==x) for x in group['ordered_xrefs']]
    camera_map=cameras(scenes);scene=scenes[0]
    if scene['xref'] not in camera_map:raise ValueError('No native or same-panel camera hypothesis')
    M=np.asarray(camera_map[scene['xref']]['matrix']);scorer=GpuColoredSceneScorer(scene,plane_depth=True)
    allowed=sorted(set(c for p,c in pieces));labels,_=classify(scene['rgb'],scene['mask'],np.stack([_rgb(c) for c in allowed]).astype(np.uint8))
    supported={c for i,c in enumerate(allowed) if (labels==i+1).sum()>=max(10,.02*scene['mask'].sum())}
    choices=sorted(partitions(pieces,stage_size),key=lambda parts:(len(set(parts)),parts))
    records=[];heap=[];serial=0;aliases={};candidate_cache={};Rs=rotations()
    for partition_index,parts in enumerate(choices):
        record=dict(parts=parts,partition_index=partition_index)
        if not supported.issubset(c for p,c in parts):record['rejected']='Missing visible base color';records.append(record);continue
        # Root choice is a coordinate gauge; choose a rare-color occurrence
        # deterministically. No pose is supplied, and all24 view gauges follow.
        frequencies=Counter(c for p,c in parts)
        anchor=min(parts,key=lambda pc:(frequencies[pc[1]],pc));incoming=parts.copy();incoming.remove(anchor)
        if len(incoming)!=2:raise ValueError('This prototype searches complete three-piece stages')
        root=[(*anchor,np.eye(4))];solid,receipt=solid_equivalent(*anchor,library)
        if receipt:aliases[anchor[0]]=receipt
        root_assembly=assembly([(solid,anchor[1],np.eye(4))]);candidate_sets=[]
        for part,color in incoming:
            solid,receipt=solid_equivalent(part,color,library)
            if receipt:aliases[part]=receipt
            key=(anchor[0],solid)
            if key not in candidate_cache:candidate_cache[key]=root_assembly.candidates(solid,check_collision=True,check_occlusion=False)
            candidate_sets.append([(part,color,c['T']) for c in candidate_cache[key]])
        record['anchor']=anchor;record['candidate_counts']=list(map(len,candidate_sets));tested=0;fitted=0;legal=0
        print('begin partition',partition_index,'parts',parts,'candidates',record['candidate_counts'],flush=True)
        collision_cache={};first_assemblies={}
        # Cheap per-view projected bounds are cached before complete pairs.
        for view_index,R in enumerate(Rs):
            projection=M@R[:3,:3];blo,bhi=projected_bounds(root,projection,scorer)
            bounds=[[projected_bounds([item],projection,scorer) for item in candidates] for candidates in candidate_sets]
            if not all(bounds):continue
            second_lo=np.asarray([lo for lo,hi in bounds[1]]);second_hi=np.asarray([hi for lo,hi in bounds[1]])
            for i,first in enumerate(candidate_sets[0]):
                low,high=bounds[0][i]
                span=np.maximum(np.maximum(high,second_hi),bhi)-np.minimum(np.minimum(low,second_lo),blo)
                passing=np.flatnonzero(np.max(abs(span-scorer.target_span)/scorer.target_span,axis=1)<=scorer.span_tolerance)
                if incoming[0]==incoming[1]:passing=passing[passing>i]
                tested+=len(candidate_sets[1]);fitted+=len(passing)
                if not len(passing):continue
                if i not in first_assemblies:
                    firstsolid=aliases.get(first[0],{}).get('solid',first[0])
                    first_assemblies[i]=assembly([(firstsolid,first[1],first[2])])
                current=first_assemblies[i]
                for j in passing:
                    second=candidate_sets[1][j];secondsolid=aliases.get(second[0],{}).get('solid',second[0])
                    key=(i,int(j))
                    if key not in collision_cache:collision_cache[key]=current.collides(secondsolid,second[2])
                    if collision_cache[key]:continue
                    legal+=1;items=root+[first,second];ev=scorer.score(items,projection)
                    if ev.get('bbox_rejected'):continue
                    row=dict(items=items,projection=projection,evidence=ev,partition=partition_index)
                    entry=(ev['score'],-serial,row);serial+=1
                    if len(heap)<keep:heapq.heappush(heap,entry)
                    elif entry[:2]>heap[0][:2]:heapq.heapreplace(heap,entry)
            print('view',view_index,'rendered',legal,'best',max((entry[0] for entry in heap),default=None),flush=True)
        record.update(tested=tested,bbox_fitted=fitted,legal_rendered=legal);records.append(record)
        print('partition',partition_index,'candidates',record['candidate_counts'],'rendered',legal,flush=True)
    rows=[r for a,b,r in sorted(heap,key=lambda x:(-x[0],-x[1]))];results=[]
    for index,row in enumerate(rows):
        filename=f'group_{index:03d}.ldr'
        # Preserve printed identities in emitted LDraw even where connectors
        # used a validated universal solid surrogate.
        lines=['0 PDF allocation-partition stage hypothesis; uncertified']
        for part,color,T in row['items']:
            values=[*T[:3,3],*T[:3,:3].ravel()]
            lines.append('1 '+str(color)+' '+' '.join(f'{v:g}' for v in values)+' '+part+'.dat')
        (out/filename).write_text('\n'.join(lines)+'\n')
        if index==0:scorer.score(row['items'],row['projection'],out/'selected.png')
        used=Counter((p,c) for p,c,T in row['items']);remaining=list((Counter(pieces)-used).elements())
        results.append(dict(file=filename,partition=row['partition'],parts=[(p,c) for p,c,T in row['items']],
            remaining_allocations=remaining,projection=row['projection'].tolist(),evidence=row['evidence']))
    report=dict(pdf=str(pdf.resolve()),**provenance,truth_used=False,runtime_vlm_calls=0,
        part_ids_derived_from_pdf=True,source_page=page,source_xref=scene['xref'],graph=graph,cameras=camera_map,
        declared_stage_size_hypothesis=stage_size,observed_supported_base_colors=sorted(supported),
        allocation_partitions=records,connector_aliases=aliases,results=results,certified=False,
        limitations=['Three-piece first-stage size is an explicit bounded search hypothesis.',
            'Both incoming pieces must attach directly to root; chained-only stages are not enumerated.',
            'Same-panel camera transfer can be wrong; no continuous camera optimization.',
            'Second numbered stage still requires completion using remaining allocations.'])
    (out/'results.json').write_text(json.dumps(report,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('pdf',type=Path);p.add_argument('--page',type=int,required=True)
    p.add_argument('--allocation-run',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.pdf,a.page,a.allocation_run,a.out)
