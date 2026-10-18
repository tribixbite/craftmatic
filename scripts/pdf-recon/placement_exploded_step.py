"""Own-page repeated-quantity constraints: built five + detached sixth.

All inputs are PDF evidence and runtime hypotheses. Stable/main component is
explicitly compared to items5, never assumed to contain only previous-step
parts. No later-page image or truth model is required.
"""
from pathlib import Path
import sys
import cv2
import numpy as np
sys.path.insert(0,'C:/git/clego')
from recon_v8 import partrender
from vector_scene_components import component_graph
from placement_part_edges import part_orientation_scores
from placement_view_registration import color_supported_locations


class ExplodedStepScorer:
    def __init__(self,scene,projection,known_items,out,origins=None,contact_weight=0,contact_mode='legacy'):
        self.scene=scene;self.projection=np.asarray(projection,float)
        self.out=Path(out);self.out.mkdir(parents=True,exist_ok=True)
        self.contact_weight=float(contact_weight)
        if contact_mode not in ('legacy','insertion'):raise ValueError('Unknown contact mode')
        self.contact_mode=contact_mode
        graph=component_graph(scene,arrow_color='red')
        if len(graph['components'])!=2:raise ValueError('Expected main + detached components')
        arrows=[a for a in graph['arrows'] if not a['direction_ambiguous']]
        if not arrows:raise ValueError('No unambiguous arrow direction')
        self.main=graph['components'][0];self.detached=graph['components'][1]
        directions=[np.asarray(a['direction'])/np.linalg.norm(a['direction']) for a in arrows]
        direction=np.mean(directions,axis=0)
        if np.linalg.norm(direction)<.8:raise ValueError('Arrow directions disagree')
        self.direction=direction/np.linalg.norm(direction)
        self.perpendicular=np.array([-self.direction[1],self.direction[0]])
        self.graph=graph;self.edge_cache={};self.geometry={};self.main_cache={}
        if origins is None:
            main_scene=dict(scene,mask=self.main['mask'])
            predictions=[color_supported_locations(main_scene,p,c,T,self.projection,self.out/'registration')
                         for p,c,T in known_items[:2]]
            if len(predictions)!=2 or not all(predictions):raise ValueError('Known pair registration unavailable')
            pairs=[]
            for a in predictions[0]:
                for b in predictions[1]:
                    distance=np.linalg.norm(np.asarray(a['image_origin'])-b['image_origin'])
                    score=(a['score']+b['score'])/2-distance/20
                    pairs.append((score,(np.asarray(a['image_origin'])+b['image_origin'])/2,distance))
            pairs.sort(key=lambda x:-x[0]);selected=[]
            for score,origin,distance in pairs:
                if any(np.linalg.norm(origin-r)<3 for r in selected):continue
                selected.append(origin)
                if len(selected)>=3:break
            self.origins=selected
        else:self.origins=[np.asarray(origin,float) for origin in origins]

    def triangles(self,part):
        if part not in self.geometry:
            path=partrender._find_dat(str(part).removesuffix('.dat')+'.dat')
            if not path or not partrender._parse_dat(path):raise ValueError('Missing actual CAD triangles')
            self.geometry[part]=partrender.part_tris(part)
        return self.geometry[part]

    def projected(self,part,T):
        points=self.triangles(part).reshape(-1,3)
        return (points@T[:3,:3].T+T[:3,3])@self.projection.T

    def main_score(self,items,origin):
        mask=np.zeros(self.main['mask'].shape,np.uint8)
        for part,color,T in items:
            T=np.asarray(T)
            key=(part,T.tobytes(),np.asarray(origin).tobytes())
            if key not in self.main_cache:
                single=np.zeros(mask.shape,np.uint8)
                triangles=np.round(self.projected(part,T)+origin).astype(np.int32).reshape(-1,3,2)
                for triangle in triangles:cv2.fillConvexPoly(single,triangle,1)
                self.main_cache[key]=single
            mask|=self.main_cache[key]
        target=self.main['mask'];pred=mask>0
        iou=float((pred&target).sum()/max(1,(pred|target).sum()))
        return iou

    def batchscore(self,items5,part,color,transforms):
        """Return score/evidence per candidate sixth-part transform, same order."""
        if not items5:raise ValueError('At least one built item is required')
        transforms=[np.asarray(T,float) for T in transforms]
        unique={tuple(np.round(T[:3,:3].flatten(),5)):T for T in transforms}
        missing=[(key,T) for key,T in unique.items() if (part,color,key) not in self.edge_cache]
        if missing:
            scores=part_orientation_scores(part,color,[T for key,T in missing],self.scene,self.detached,self.out/'orientation',projection=self.projection)
            for (key,T),score in zip(missing,scores):self.edge_cache[(part,color,key)]=float(score)
        main=[self.main_score(items5,origin) for origin in self.origins]
        contacts=None
        if self.contact_weight:
            from placement_arrow_contacts import batch_score_contact_targets,batch_score_insertion_targets
            contact_scorer=batch_score_insertion_targets if self.contact_mode=='insertion' else batch_score_contact_targets
            contacts=[contact_scorer(items5,part,transforms,self.projection,origin,self.graph['arrows']) for origin in self.origins]
        box=np.asarray(self.detached['bbox']);observed_center=(box[:2]+box[2:])/2
        observed_span=box[2:]-box[:2];normalizer=max(1,float(np.mean(observed_span)))
        results=[]
        for transform_index,T in enumerate(transforms):
            projected=self.projected(part,T);lo,hi=projected.min(0),projected.max(0)
            center=(lo+hi)/2;span=hi-lo
            size_error=float(np.linalg.norm(span-observed_span)/max(1,np.linalg.norm(observed_span)))
            key=tuple(np.round(T[:3,:3].flatten(),5));appearance=self.edge_cache[(part,color,key)]
            attempts=[]
            for origin_index,(origin,stable_iou) in enumerate(zip(self.origins,main)):
                delta=center+origin-observed_center
                transverse=abs(float(delta@self.perpendicular))/normalizer
                along=float(delta@self.direction)
                reverse=max(0.,-along)/normalizer
                score=stable_iou+appearance-2*transverse-size_error-2*reverse
                contact=contacts[origin_index][transform_index] if contacts is not None else None
                if contact and contact.get('supported'):score+=self.contact_weight*contact['score']
                evidence=dict(score=float(score),stable_main_iou=stable_iou,detached_appearance=appearance,
                    transverse_error=transverse,size_error=size_error,along_arrow_px=along,
                    image_origin=origin.tolist(),certified=False)
                if contact is not None:evidence['arrow_contact']=contact
                attempts.append(evidence)
            best=max(attempts,key=lambda r:r['score']);results.append(best)
        return results


def diagnostic(out,contact_weight=0):
    import json
    import pymupdf
    from recon_v8.assembly import Assembly
    from vector_scene import scene_images
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    path=Path('output/pdf-placement-beam/40377-registered-six-v1/model.ldr')
    items=[]
    for line in path.read_text().splitlines():
        fields=line.split()
        if len(fields)>=15 and fields[0]=='1':
            T=np.eye(4);T[:3,3]=list(map(float,fields[2:5]));T[:3,:3]=np.asarray(list(map(float,fields[5:14]))).reshape(3,3)
            items.append((fields[14].removesuffix('.dat'),int(fields[1]),T))
    known=items[:4]
    camera=json.loads(Path('output/pdf-placement-beam/40377-pair-camera-v1/results.json').read_text())['camera']['matrix']
    doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf');scene=scene_images(doc,doc[3])[0]
    scorer=ExplodedStepScorer(scene,camera,known,out,contact_weight=contact_weight)
    asm=Assembly()
    for p,c,T in known:asm.add(p,c,T)
    candidates=asm.candidates('2420',check_collision=True,check_occlusion=False)
    ranked=[]
    for candidate in candidates:
        T=candidate['T'];current=known+[('2420',15,T)]
        score=max(scorer.main_score(current,origin) for origin in scorer.origins)
        ranked.append((score,T))
    ranked.sort(key=lambda p:-p[0]);proposals=[]
    for main_score,T in ranked[:6]:
        current=known+[('2420',15,T)];a=Assembly()
        for p,c,transform in current:a.add(p,c,transform)
        second=a.candidates('2420',check_collision=True,check_occlusion=False)
        scores=scorer.batchscore(current,'2420',15,[c['T'] for c in second])
        for candidate,evidence in zip(second,scores):proposals.append((evidence,current+[('2420',15,candidate['T'])]))
    proposals.sort(key=lambda p:-p[0]['score'])
    records=[]
    for index,(evidence,proposal) in enumerate(proposals[:20]):
        a=Assembly()
        for p,c,T in proposal:a.add(p,c,T)
        (out/f'proposal_{index:03d}.ldr').write_text(a.to_ldr(),encoding='utf-8')
        records.append(dict(evidence=evidence,added_transforms=[T.tolist() for p,c,T in proposal[4:]]))
    result=dict(runtime_prefix_source=str(path),page=3,origins=[o.tolist() for o in scorer.origins],
        first_candidates=len(candidates),first_retained=min(6,len(ranked)),full_proposals=len(proposals),
        main_component_interpretation='five built items, one detached incoming item',results=records,
        truth_used=False,limitations=['Bounded first-six beam; missing candidate is not proof of impossible placement.',
                                     'No independent truth evaluation; proposals only.'])
    (out/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);parser.add_argument('--contact-weight',type=float,default=0)
    args=parser.parse_args();diagnostic(args.out,args.contact_weight)
