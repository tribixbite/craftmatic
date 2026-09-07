"""Independent combinatorial controls for joint repeated-group enumeration."""
import argparse
import json
from pathlib import Path
import numpy as np
from placement_repeated_groups import compatible_pairs,score_repeated_pair


def span_control():
    rng=np.random.default_rng(7319);trials=0;pairs=0
    for n in [0,1,2,7,23]:
        for tolerance in [0.,.1,.35,1.]:
            for _ in range(20):
                lows=rng.normal(0,20,(n,2));highs=lows+rng.uniform(0,30,(n,2))
                blo=np.array([-4.,-3.]);bhi=np.array([6.,9.]);target=rng.uniform(1,70,2)
                expected=[]
                for i in range(n):
                    for j in range(i+1,n):
                        lo=np.min(np.array([lows[i],lows[j],blo]),axis=0)
                        hi=np.max(np.array([highs[i],highs[j],bhi]),axis=0)
                        if all(abs(hi-lo-target)/target<=tolerance):expected.append((i,j))
                actual=list(compatible_pairs(lows,highs,blo,bhi,target,tolerance))
                assert actual==expected
                trials+=1;pairs+=len(expected)
    # Exactly on, immediately below, and immediately above a gate boundary.
    for span in [12.5,np.nextafter(12.5,0),np.nextafter(12.5,np.inf)]:
        result=list(compatible_pairs([[0,0],[0,0]],[[1,1],[span,10]],[0,0],[1,1],[10,10],.25))
        assert bool(result)==(span<=12.5)
    return dict(random_trials=trials,accepted_pairs=pairs,boundary_cases=3,brute_force_exact=True)


class FakeScorer:
    target_span=np.array([10.,10.]);span_tolerance=10.
    def __init__(self,tied=False):self.calls=[];self.tied=tied
    def _project_part(self,part,color,T,projection):return dict(lo=np.zeros(2),hi=np.ones(2))
    def score(self,items,projection):
        # This deliberately fails if an implementation ranks a first copy
        # alone, which can discard a weak singleton belonging to the best pair.
        assert len(items)==3,'Only complete two-copy assemblies may be image-scored'
        pair=tuple(sorted(int(part[1:]) for part,color,T in items[1:]))
        self.calls.append((pair,projection.tobytes()))
        value=1. if self.tied else (100. if pair==(2,3) else 10.-sum(pair))
        return dict(score=value)


def search_control():
    T=np.eye(4);base=[('base',15,T.copy())];placements=[]
    for index in range(4):
        pose=T.copy();pose[0,3]=index*2
        placements.append(dict(items=[(f'p{index}',15,pose)],anchor_index=index))
    collision_calls=[]
    class Assembly:
        def __init__(self,items):self.owner=int(items[0][0][1:])
        def collides(self,part,T):
            pair=(self.owner,int(part[1:]));collision_calls.append(pair)
            return pair==(0,1)
    def make(items,solids):return Assembly(items)
    M=np.array([[1.,0,0],[0,1.,0]])
    scorer=FakeScorer();rows,stats=score_repeated_pair(base,placements,[M,M],scorer,make,{},'synthetic',keep=3)
    assert rows[0]['placement_indices']==[2,3]
    assert len(scorer.calls)==10 and len(collision_calls)==6
    assert all(pair!=(0,1) for pair,view in scorer.calls)
    tied=FakeScorer(tied=True);first,first_stats=score_repeated_pair(base,placements,[M,M],tied,make,{},'synthetic',keep=3)
    second,_=score_repeated_pair(base,placements,[M,M],FakeScorer(tied=True),make,{},'synthetic',keep=3)
    a=[r['placement_indices'] for r in first];b=[r['placement_indices'] for r in second]
    assert a==b==[[0,2],[0,3],[1,2]]
    return dict(best_joint_pair=rows[0]['placement_indices'],all_complete_pairs_scored=True,
        deterministic_ties=a,collision_cache_checks=6,views=2,statistics=stats)


def run(out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    result=dict(span=span_control(),joint_search=search_control(),
        scope='Synthetic candidate enumeration correctness; no CAD, PDF pose truth, or placement accuracy claim')
    (out/'results.json').write_text(json.dumps(result,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);run(p.parse_args().out)
