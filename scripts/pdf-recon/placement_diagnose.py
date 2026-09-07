"""Evaluation-only diagnosis. Independent OMR never feeds reconstruction."""
from pathlib import Path
import json, itertools, sys
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_bipartite_matching
from pose_score import read_parts, score

OUT=Path('output/pdf-placement-diagnosis')
RUN=Path('output/pdf-crop-trial-v5/40377-joint-cnn')
TRUTH=Path('C:/git/clego/lego_sets/OMR/40377-1.mpd')

def position_upper(recon, truth):
    """Ignore every part rotation; exhaustive integer translation/24 global axes."""
    rp=np.array([p[2] for p in recon]); tp=np.array([p[2] for p in truth])
    compat=np.array([[(a[0],a[1])==(b[0],b[1]) for b in truth] for a in recon])
    ia,ib=np.where(compat); best=0; bt=None; tested=0
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((-1,1),repeat=3):
            R=np.eye(3)[list(perm)]*np.array(signs)[:,None]
            if np.linalg.det(R)<.99: continue
            p=rp@R.T
            offsets=np.unique(np.round(tp[ib]-p[ia],5),axis=0)
            for offset in offsets:
                edges=compat & (np.max(np.abs(p[:,None,:]+offset-tp[None,:,:]),axis=2)<=1.000001)
                tested+=1
                if min(np.count_nonzero(edges.any(axis=0)),np.count_nonzero(edges.any(axis=1)))<=best: continue
                n=int(np.sum(maximum_bipartite_matching(csr_matrix(edges),perm_type='column')>=0))
                if n>best:best=n;bt={'rotation':R.tolist(),'offset':offset.tolist()}
    return {'matched':best,'truth':len(truth),'coverage':best/len(truth),'hypotheses':tested,'alignment':bt,'limitation':'Orientation-free optimistic position diagnostic; global rotations restricted to 24 orthogonal frames; origin-preserving identities only.'}

def first_candidates(recon,truth):
    sys.path.insert(0,'C:/git/clego')
    from recon_v8 import place
    anchor=next(p for p in truth if p[:2]==recon[0][:2])
    R=anchor[3]@recon[0][3].T; off=anchor[2]-R@recon[0][2]
    asm=place.new_assembly(); first=np.eye(4);first[:3,:3]=recon[0][3];first[:3,3]=recon[0][2];asm.add(recon[0][0],recon[0][1],first)
    target=next(p for p in truth if p[:2]==recon[1][:2]); T=np.eye(4);T[:3,:3]=R.T@target[3];T[:3,3]=R.T@(target[2]-off)
    raw=asm.candidates(recon[1][0],kinds=place.KINDS,with_slide=False,check_collision=False,check_occlusion=True)
    ranked,stats=place.rank_candidates(asm,recon[1][0],recon[0][2],k=90,budget=90,pagectx=None,color=recon[1][1],page_prefilter=False)
    def dist(c):return float(np.max(np.abs(c['T'][:3,3]-T[:3,3])))
    def exact(c):return dist(c)<=1 and bool(np.allclose(c['T'][:3,:3],T[:3,:3],atol=1e-4))
    return {'anchor':recon[0][0],'second_part':recon[1][0],'target_in_anchor_gauge':T.tolist(),'generated_second':{'position':recon[1][2].tolist(),'rotation':recon[1][3].tolist()},'raw_count':len(raw),'raw_exact':sum(map(exact,raw)),'raw_position_only':sum(dist(c)<=1 for c in raw),'raw_min_position_error_ldu':min(map(dist,raw),default=None),'ranked_count':len(ranked),'ranked_exact_indices':[i for i,c in enumerate(ranked) if exact(c)],'ranked_position_indices':[i for i,c in enumerate(ranked) if dist(c)<=1],'stats':stats,'recon_anchor_distance':float(np.linalg.norm(recon[1][2]-recon[0][2])),'truth_anchor_distance':float(np.linalg.norm(target[2]-anchor[2]))}

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    r,t=read_parts(RUN/'model.ldr'),read_parts(TRUTH)
    result={'scope':'Evaluation only; no truth consumed by assembler','recon':str(RUN),'truth':str(TRUTH),'strict':score(r,t),'position_only_exact_ids':position_upper(r,t),'first_placement':first_candidates(r,t)}
    (OUT/'diagnosis.json').write_text(json.dumps(result,indent=2))
    print(OUT/'diagnosis.json')
