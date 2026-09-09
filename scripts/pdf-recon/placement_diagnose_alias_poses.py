"""Post-hoc strict, authoritative-alias and unprinted yaw-equivalence scores."""
from collections import defaultdict
from pathlib import Path
import json,sys
import hashlib
from functools import lru_cache
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_bipartite_matching
from pose_score import read_parts,score
from placement_part_library import PartLibrary


@lru_cache(maxsize=1)
def verified_rename_graph():
    path=Path('output/pdf-placement-diagnosis/3023b-rename-symmetry.json')
    proof=json.loads(path.read_text())
    if not proof['same_bounds'] or not proof['new_full_triangle_yaw180_invariant'] or hashlib.sha256(Path(proof['file']).read_bytes()).hexdigest()!=proof['sha256']:
        raise ValueError('Universal rename/symmetry proof invalid or geometry changed')
    if not any('Moved from 3023.dat' in line for line in proof['rename_lines']):raise ValueError('Authoritative rename header missing')
    return {'3023':'3023b'},proof


def canonicalize(parts,library):
    rows=[];aliases={};renames,_=verified_rename_graph()
    for part,color,p,R in parts:
        canonical=library.aliases.get(part+'.dat')
        name=renames.get(canonical.stem if canonical else part,canonical.stem if canonical else part)
        if name!=part:aliases[part]=name
        rows.append((name,color,p,R))
    return rows,aliases


LEGACY_SYMMETRY_NOTE='Hand-listed symmetries retained only to reproduce earlier reported numbers'


def legacy_local_symmetries(part):
    Y=np.diag([-1.,1.,-1.])
    Q=np.array([[0.,0.,1.],[0.,1.,0.],[-1.,0.,0.]])
    if part=='3941':return [np.eye(3),Q,Y,Q.T]
    return [np.eye(3),Y] if part in ('3010','3710','3020','3023b','3005','3069b','3003','4032a') else [np.eye(3)]


def verified_local_symmetries(part):
    # Proper rotations proven from universal CAD; printed moulds keep identity.
    from placement_part_symmetry_table import symmetries
    return list(symmetries(part,'vertex'))


def yaw_equivalent_matching(recon,truth,local_symmetries=None):
    """The structural matching itself, not only its size.

    Identical enumeration and objective to `yaw_equivalent_score`, which is now a
    thin wrapper, so a population table that asks *which* reference instances are
    unmatched reports the same instances the headline number counts. Returns the
    best matching as reconstruction-index -> reference-index pairs together with
    the global rigid transform that realised it.
    """
    groups=defaultdict(list)
    local_symmetries=local_symmetries or legacy_local_symmetries
    for i,p in enumerate(truth):groups[p[:2]].append(i)
    transforms={}
    for part,color,p,R in recon:
        for i in groups[(part,color)]:
            _,_,tp,tR=truth[i]
            for local in local_symmetries(part):
                rotation=tR@local@R.T
                if np.linalg.det(rotation)<.999:continue
                offset=tp-rotation@p
                transforms.setdefault(tuple(np.round(np.r_[rotation.flatten(),offset],4)),(rotation,offset))
    best=0;best_pairs=[];best_transform=None
    for rotation,offset in transforms.values():
        edges=[]
        for j,(part,color,p,R) in enumerate(recon):
            for i in groups[(part,color)]:
                _,_,tp,tR=truth[i]
                if np.max(np.abs(rotation@p+offset-tp))>1.000001:continue
                variants=[tR@local for local in local_symmetries(part)]
                if any(np.allclose(rotation@R,v,atol=1e-4,rtol=0) for v in variants):edges.append((j,i))
        if len(edges)<=best:continue
        a,b=zip(*edges);graph=csr_matrix((np.ones(len(edges)),(a,b)),shape=(len(recon),len(truth)))
        assignment=maximum_bipartite_matching(graph,perm_type='column')
        matched=int(np.sum(assignment>=0))
        if matched>best:
            best=matched
            # perm_type='column' returns, per reconstruction row, the reference
            # column it is matched to, so the array is indexed by recon part.
            best_pairs=[(int(j),int(assignment[j])) for j in range(len(recon)) if assignment[j]>=0]
            best_transform={'rotation':rotation.tolist(),'translation':offset.tolist()}
    return best,best_pairs,best_transform


def yaw_equivalent_score(recon,truth,local_symmetries=None):
    best,pairs,transform=yaw_equivalent_matching(recon,truth,local_symmetries)
    return {'matched':best,'recon_parts':len(recon),'truth_parts':len(truth),'precision':best/len(recon),'coverage':best/len(truth),'matched_pairs':pairs,'alignment':transform,'symmetry_source':'placement_part_symmetry_table (saved universal-CAD proofs) unless the legacy hand list is requested','symmetry_evidence':'output/pdf-placement-diagnosis/<part>-full-symmetry.json, produced by placement_verify_part_symmetries','limitations':'Structural universal-CAD equivalence; embossed logos not evaluated; no symmetry granted to printed parts.'}


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('run',type=Path);parser.add_argument('pattern',nargs='?',default='beam_*.ldr');parser.add_argument('--truth',default='C:/git/clego/lego_sets/OMR/40377-1.mpd');parser.add_argument('--out',type=Path)
    args=parser.parse_args();run=args.run;metadata=json.loads((run/'results.json').read_text())
    if metadata.get('truth_used') is not False:raise ValueError('Runtime input provenance lacks truth-free declaration')
    library=PartLibrary();truth=read_parts(args.truth);ct,aliases=canonicalize(truth,library);rows=[]
    pattern=args.pattern
    for path in sorted(run.glob(pattern)):
        recon=read_parts(path);cr,found=canonicalize(recon,library);aliases.update(found)
        rows.append({'file':path.name,'strict':score(recon,truth),'canonical_alias':score(cr,ct),
            'canonical_structural_yaw':yaw_equivalent_score(cr,ct,verified_local_symmetries),
            'legacy_hand_listed_yaw':yaw_equivalent_score(cr,ct,legacy_local_symmetries)})
    from placement_part_symmetry_table import table as symmetry_table
    result={'symmetry_table':symmetry_table(sorted({p for p,_,_,_ in ct})),'scope':'Independent OMR evaluation only. Authoritative filename aliases and declared unprinted structural symmetries reported separately from raw strict score. No evaluation chooses runtime output.','run':str(run),'aliases':aliases,'alias_provenance':library.provenance,'rename_provenance':verified_rename_graph()[1],'selected':rows[0],'oracle_best_strict':max(rows,key=lambda r:r['strict']['matched']),'oracle_best_structural':max(rows,key=lambda r:r['canonical_structural_yaw']['matched']),'beams':rows}
    result['truth_path']=args.truth
    out=args.out or Path('output/pdf-placement-diagnosis')/(run.name+'-alias-poses.json');out.write_text(json.dumps(result,indent=2));print(out)
