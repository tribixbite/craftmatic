"""Infer connected pair poses from detached silhouettes and arrow directions."""
import numpy as np
from placement_gpu_render import SurfaceScorer
from vector_scene import scene_images
from vector_scene_components import component_graph
from recon_v8.assembly import Assembly


def propose(doc,page,first,second,rotations,device='cuda',limit=48,edge_cache=None,projection=None):
    part1,color1=first;part2,color2=second
    scorer=SurfaceScorer(device=device,projection=projection)
    projection=scorer.matrix.cpu().numpy()
    rotation_key=lambda T:tuple(np.round(T[:3,:3].flatten(),4))
    geometry={}
    for part in (part1,part2):
        pts=scorer.points(part).cpu().numpy()
        geometry[part]={}
        for T in rotations:
            projected=pts@T[:3,:3].T@projection.T
            lo,hi=projected.min(0),projected.max(0)
            geometry[part][rotation_key(T)]=(hi-lo,(hi+lo)/2)
    candidates=[]
    for base in rotations:
        a=Assembly();a.add(part1,color1,base)
        for mate in a.candidates(part2,kinds=('CYL','CLP','FGR','GEN'),
                                 check_collision=True,check_occlusion=False):
            candidates.append((base,mate['T']))
    proposals=[]
    for scene in scene_images(doc,doc[page]):
        graph=component_graph(scene)
        components=graph['components']
        arrows=[a for a in graph['arrows'] if not a['direction_ambiguous']]
        if len(components)!=2 or not arrows:continue
        direction=np.mean([np.asarray(a['direction'])/np.linalg.norm(a['direction']) for a in arrows],axis=0)
        if np.linalg.norm(direction)<.8:continue
        direction/=np.linalg.norm(direction)
        perpendicular=np.array([-direction[1],direction[0]])
        shape={}
        for ci,component in enumerate(components):
            scorer.scene(component['mask'])
            for part in (part1,part2):
                scores=scorer.score([],part,rotations)
                if edge_cache is not None:
                    from placement_part_edges import part_orientation_scores
                    color=color1 if part==part1 else color2
                    scores=part_orientation_scores(part,color,rotations,scene,component,edge_cache,projection=projection)
                shape[(ci,part)]={rotation_key(T):float(s) for T,s in zip(rotations,scores)}
        for ci,cj in ((0,1),(1,0)):
            boxes=[np.asarray(components[k]['bbox']) for k in (ci,cj)]
            centers=[(box[:2]+box[2:])/2 for box in boxes]
            spans=np.concatenate([box[2:]-box[:2] for box in boxes])
            for base,mate in candidates:
                key1,key2=rotation_key(base),rotation_key(mate)
                span1,center1=geometry[part1][key1]
                span2,center2=geometry[part2][key2]
                projected_spans=np.concatenate([span1,span2])
                scale=float(projected_spans@spans/max(1e-6,projected_spans@projected_spans))
                size_error=float(np.linalg.norm(projected_spans*scale-spans)/max(1,np.linalg.norm(spans)))
                predicted=(center2+projection@mate[:3,3]-center1-projection@base[:3,3])*scale
                observed=centers[1]-centers[0]
                # Detached translations are allowed ONLY along the arrow ray;
                # the transverse position must agree with the mated geometry.
                error=predicted-observed
                transverse=abs(float(error@perpendicular))/max(1,float(np.mean(spans)))
                score=(shape[(ci,part1)][key1]+shape[(cj,part2)][key2])/2-2*size_error-2*transverse
                proposals.append({'items':[(part1,color1,base),(part2,color2,mate)],
                    'score':score,'history_score':0.,'evidence':{'page':page,'xref':scene['xref'],
                    'components':[ci,cj],'shape_scores':[shape[(ci,part1)][key1],shape[(cj,part2)][key2]],
                    'size_error':size_error,'transverse_error':transverse,'scale':scale,
                    'arrow_direction':direction.tolist()}})
    proposals.sort(key=lambda p:-p['score'])
    unique=[];seen=set()
    for proposal in proposals:
        key=tuple(tuple(np.round(T.flatten(),4)) for p,c,T in proposal['items'])
        if key not in seen:
            seen.add(key);unique.append(proposal)
            if len(unique)>=limit:break
    return unique
