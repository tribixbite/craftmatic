"""Deterministic triangle-parity overlap diagnostics; no runtime rejection gate.

Parallel rays cross actual universal CAD surfaces. Three axes and offset
lattice phases expose non-watertight/duplicate-surface ambiguity instead of
declaring every bounding-box or surface-voxel intersection a collision.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary
from placement_arrow_contacts import read_items
from placement_beam import assembly


def inside_mesh(triangles,points,axis=0,return_valid=False):
    """Odd unique triangle crossings from sample points toward +axis."""
    t=np.asarray(triangles,float);p=np.asarray(points,float)
    others=[i for i in range(3) if i!=axis];uv=t[:,:,others];a=uv[:,0];e=uv[:,1]-a;f=uv[:,2]-a
    det=e[:,0]*f[:,1]-e[:,1]*f[:,0];keep=np.abs(det)>1e-10
    t=t[keep];a=a[keep];e=e[keep];f=f[keep];det=det[keep]
    rays,inverse=np.unique(p[:,others],axis=0,return_inverse=True);crossings=[]
    for start in range(0,len(rays),128):
        q=rays[start:start+128,None,:]-a
        b=(q[:,:,0]*f[None,:,1]-q[:,:,1]*f[None,:,0])/det
        c=(e[None,:,0]*q[:,:,1]-e[None,:,1]*q[:,:,0])/det
        inside=(b>=-1e-10)&(c>=-1e-10)&(b+c<=1+1e-10)
        x=t[None,:,0,axis]+b*(t[None,:,1,axis]-t[None,:,0,axis])+c*(t[None,:,2,axis]-t[None,:,0,axis])
        for values,valid in zip(x,inside):crossings.append(np.unique(np.round(values[valid],7)))
    occupied=np.zeros(len(p),bool);valid=np.zeros(len(p),bool)
    order=np.argsort(inverse,kind='stable');ends=np.r_[0,np.cumsum(np.bincount(inverse,minlength=len(rays)))]
    for i,values in enumerate(crossings):
        idx=order[ends[i]:ends[i+1]];occupied[idx]=(np.searchsorted(values,p[idx,axis]+1e-8,side='right')%2)==1
        valid[idx]=len(values)%2==0
    return (occupied,valid) if return_valid else occupied


def measure(triangles_a,triangles_b,step=1.,phase=(.173,.397,.619)):
    low=np.minimum(triangles_a.min((0,1)),triangles_b.min((0,1)));high=np.maximum(triangles_a.max((0,1)),triangles_b.max((0,1)))
    coords=[np.arange(np.floor(low[i]/step),np.ceil(high[i]/step))*step+phase[i]*step for i in range(3)]
    points=np.stack(np.meshgrid(*coords,indexing='ij'),-1).reshape(-1,3);rows=[];aa=[];bb=[];valids=[]
    for axis in range(3):
        a,va=inside_mesh(triangles_a,points,axis,True);b,vb=inside_mesh(triangles_b,points,axis,True);aa.append(a);bb.append(b);valids.append(va&vb)
        both=int((a&b).sum());rows.append(dict(axis=axis,volume_a=float(a.sum()*step**3),volume_b=float(b.sum()*step**3),
            overlap_volume=float(both*step**3),overlap_fraction_of_smaller=both/max(1,min(a.sum(),b.sum())),
            closed_ray_overlap_volume=float((a&b&va&vb).sum()*step**3),invalid_ray_samples=int((~(va&vb)).sum())))
    agreement_a=np.sum((aa[0]!=aa[1])|(aa[1]!=aa[2]));agreement_b=np.sum((bb[0]!=bb[1])|(bb[1]!=bb[2]))
    xz=aa[0]&aa[2]&bb[0]&bb[2];consensus=xz&aa[1]&bb[1]
    def bounds(m):return [points[m].min(0).tolist(),points[m].max(0).tolist()] if m.any() else None
    trustworthy=consensus&valids[0]&valids[1]&valids[2]
    return dict(step_ldu=step,phase=phase,samples=len(points),axes=rows,
        all_closed_rays_agreed_overlap_volume=float(trustworthy.sum()*step**3),all_closed_rays_overlap_bounds=bounds(trustworthy),
        xz_agreed_overlap_volume=float(xz.sum()*step**3),xz_overlap_bounds=bounds(xz),
        all_axes_agreed_overlap_volume=float(consensus.sum()*step**3),all_axes_overlap_bounds=bounds(consensus),
        axis_disagreement_voxels_a=int(agreement_a),axis_disagreement_voxels_b=int(agreement_b),
        certified=False,warning='Parity is ambiguous for non-closed or coincident duplicate CAD surfaces; no production gate')


def mesh(item,library):
    part,color,T=item;t=colored_triangles(part,color,resolver=library.resolve)['triangles']
    return t@T[:3,:3].T+T[:3,3]


def proper_surface_crossings(a,b,epsilon=1e-5):
    """Strict edge-through-face intersections, excluding coplanar/touch cases.

    This does not require a watertight mesh. It is diagnostic evidence of
    intersecting surfaces, not a calibrated generic collision threshold.
    """
    records=[]
    for direction,(source,target) in enumerate(((a,b),(b,a))):
        ends=np.concatenate([source[:,[0,1]],source[:,[1,2]],source[:,[2,0]]])
        origins=ends[:,0];vectors=ends[:,1]-origins
        e1=target[:,1]-target[:,0];e2=target[:,2]-target[:,0]
        for start in range(0,len(ends),64):
            o=origins[start:start+64,None,:];d=vectors[start:start+64,None,:]
            h=np.cross(d,e2);det=np.sum(e1*h,2);valid=np.abs(det)>1e-8
            inv=np.divide(1.,det,out=np.zeros_like(det),where=valid)
            s=o-target[:,0];u=np.sum(s*h,2)*inv;q=np.cross(s,e1)
            v=np.sum(d*q,2)*inv;t=np.sum(e2*q,2)*inv
            hit=valid&(u>epsilon)&(v>epsilon)&(u+v<1-epsilon)&(t>epsilon)&(t<1-epsilon)
            ii,jj=np.where(hit)
            for i,j in zip(ii,jj):
                point=origins[start+i]+t[i,j]*vectors[start+i]
                records.append(dict(direction=direction,segment=int(start+i),triangle=int(j),point=point.tolist()))
    unique=np.unique(np.round([r['point'] for r in records],5),axis=0) if records else np.empty((0,3))
    return dict(segment_face_crossings=len(records),unique_crossing_points=len(unique),points=unique.tolist(),
        protocol='Strict noncoplanar segment-interior to triangle-interior intersections; reciprocal directions; epsilon1e-5')


def box(lo,hi):
    x0,y0,z0=lo;x1,y1,z1=hi
    vertices=np.array([[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]],float)
    quads=[[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5],[0,3,7,4]]
    return np.array([vertices[[q[0],q[1],q[2]]] for q in quads]+[vertices[[q[0],q[2],q[3]]] for q in quads])


def run(runtime,out):
    out.mkdir(parents=True,exist_ok=True);control=measure(box([0,0,0],[10,10,10]),box([5,0,0],[15,10,10]))
    assert all(r['overlap_volume']==500 and r['overlap_fraction_of_smaller']==.5 for r in control['axes'])
    items=read_items(runtime/'model.ldr')[:2];library=PartLibrary()
    unique=next((p,c) for p,c,T in items if len(colored_triangles(p,c,resolver=library.resolve)['triangles'])==max(len(colored_triangles(q,k,resolver=library.resolve)['triangles']) for q,k,U in items))
    # Pick a legal control only by universal top stud / bottom cavity mating,
    # with matching upright rotation; no set-specific reference transform.
    small=next((p,c) for p,c,T in items if (p,c)!=unique)
    base=[(*unique,np.eye(4))];candidates=assembly(base).candidates(small[0],check_collision=True,check_occlusion=False)
    candidate=next(c for c in candidates if np.allclose(c['T'][:3,:3],np.eye(3)) and c['T'][1,3]<0)
    legal=[base[0],(*small,candidate['T'])]
    illegal=[base[0],(*small,np.eye(4))]
    fixtures=[('selected_runtime_pair',items),('universal_upright_mated_control',legal),('coincident_solid_control',illegal)]
    results=[]
    for name,pair in fixtures:
        a,b=[mesh(i,library) for i in pair]
        measured=measure(a,b)
        fine=measure(a,b,step=.5,phase=(.319,.571,.227)) if name!='coincident_solid_control' else None
        results.append(dict(name=name,items=[dict(part=p,color=c,T=T.tolist()) for p,c,T in pair],fine_offset_check=fine,**measured))
        print(name,measured['axes'],flush=True)
    report=dict(runtime_source=str(runtime),truth_used=False,synthetic_half_box_control=control,fixtures=results,
        limitations=['Mesh parity diagnostic only; axis disagreement prevents exact-solid certification.','Controls arise from universal CAD and mating, not reference poses.'])
    (out/'results.json').write_text(json.dumps(report,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.runtime,a.out)
