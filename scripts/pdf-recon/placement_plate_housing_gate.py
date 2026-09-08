"""Optional exact-surface rejection for thin rigid plate housing pairs only."""
import re
import numpy as np
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary


def has_proper_crossing(a,b,epsilon=1e-5):
    """Broadphase-filtered strict noncoplanar surface crossing, early exit."""
    if np.any(np.minimum(a.max((0,1)),b.max((0,1)))-np.maximum(a.min((0,1)),b.min((0,1)))<=1e-7):return False
    for source,target in ((a,b),(b,a)):
        ends=np.concatenate([source[:,[0,1]],source[:,[1,2]],source[:,[2,0]]])
        lo=ends.min(1);hi=ends.max(1);tl=target.min(1);th=target.max(1)
        e1=target[:,1]-target[:,0];e2=target[:,2]-target[:,0]
        for start in range(0,len(ends),64):
            broad=np.all((hi[start:start+64,None,:]>=tl-1e-8)&(lo[start:start+64,None,:]<=th+1e-8),2)
            i,j=np.where(broad)
            if not len(i):continue
            o=ends[start+i,0];d=ends[start+i,1]-o;h=np.cross(d,e2[j]);det=np.sum(e1[j]*h,1)
            valid=np.abs(det)>1e-8;inv=np.divide(1.,det,out=np.zeros_like(det),where=valid)
            s=o-target[j,0];u=np.sum(s*h,1)*inv;q=np.cross(s,e1[j]);v=np.sum(d*q,1)*inv;t=np.sum(e2[j]*q,1)*inv
            if np.any(valid&(u>epsilon)&(v>epsilon)&(u+v<1-epsilon)&(t>epsilon)&(t<1-epsilon)):return True
    return False


class PlateHousingGate:
    def __init__(self):
        self.library=PartLibrary();self.geometry={};self.eligible={};self.cache={};self.files={};self.calls=0;self.rejected=0

    def part(self,part):
        if part not in self.geometry:
            parsed=colored_triangles(part,16,resolver=self.library.resolve);self.geometry[part]=parsed['triangles'];self.files.update(parsed['files'])
            header=self.library.resolve(part).read_text(errors='replace').splitlines()[0]
            span=np.ptp(parsed['triangles'].reshape(-1,3),axis=0)
            self.eligible[part]=bool(re.match(r'^0 Plate\s+\d+\s+x\s+\d+(?:\s|$)',header) and span[1]<=12.00001)
        return self.geometry[part]

    def check(self,items):
        self.calls+=1
        for i,(pa,ca,Ta) in enumerate(items):
            self.part(pa)
            for pb,cb,Tb in items[i+1:]:
                self.part(pb)
                if not (self.eligible[pa] and self.eligible[pb]):continue
                if pa>pb:p,q,A,B=pb,pa,Tb,Ta
                else:p,q,A,B=pa,pb,Ta,Tb
                relative=np.linalg.inv(A)@B;key=(p,q,tuple(np.round(relative.ravel(),5)))
                if key not in self.cache:
                    a=self.geometry[p];b=self.geometry[q]@relative[:3,:3].T+relative[:3,3]
                    self.cache[key]=has_proper_crossing(a,b)
                if self.cache[key]:self.rejected+=1;return False
        return True

    def evidence(self):
        return dict(calls=self.calls,rejected_calls=self.rejected,unique_relative_pairs=len(self.cache),
            rejected_relative_pairs=sum(self.cache.values()),eligible=self.eligible,geometry_files=self.files,
            method='Optional thin rectangular Plate header +height<=12LDU; strict noncoplanar surface crossings; cached relative rigid transforms',
            limitations=['Restricted rigid plate-pair scope, not an all-LEGO interference policy.','Unmodeled elastic effects and catalog defects are outside this trial.'])
