"""Infer an orthographic camera from detected stud grids and ellipse shapes.

Uses only image centers/axes plus universal 20 LDU stud spacing and 12 LDU
cap diameter. Missing/outlying detections remain uncertainty, not absent parts.
"""
import itertools
import json
from pathlib import Path
import numpy as np


def infer_camera(detections):
    if len(detections)<3:
        return {'ok':False,'reason':'At least three stud ellipse detections required'}
    centers=np.array([p['center'] for p in detections],float)
    covariances=[]
    for p in detections:
        a=np.radians(p['angle']);R=np.array([[np.cos(a),-np.sin(a)],[np.sin(a),np.cos(a)]])
        covariances.append(R@np.diag(np.array(p['axes'])**2)@R.T)
    covariance=np.median(covariances,axis=0)
    major=float(np.sqrt(np.linalg.eigvalsh(covariance).max()))
    vectors=[]
    for a,b in itertools.combinations(centers,2):
        v=b-a
        if v[0]<0 or (v[0]==0 and v[1]<0):v=-v
        if .65*major<=np.linalg.norm(v)<=2.2*major:vectors.append(v)
    clusters=[]
    for v in vectors:
        for cluster in clusters:
            if np.linalg.norm(v-np.mean(cluster,axis=0))<max(1.5,.07*major):
                cluster.append(v);break
        else:clusters.append([v])
    means=[np.mean(c,axis=0) for c in clusters]
    proposals=[]
    for i,j in itertools.combinations(range(len(means)),2):
        A,B=means[i],means[j];basis=np.column_stack((A,B))
        if abs(np.linalg.det(basis))<.2*np.linalg.norm(A)*np.linalg.norm(B):continue
        predicted=.36*(np.outer(A,A)+np.outer(B,B))
        covariance_error=float(np.linalg.norm(predicted-covariance)/np.linalg.norm(covariance))
        coords=(centers-centers[0])@np.linalg.inv(basis).T
        grid_error=float(np.mean(np.linalg.norm(coords-np.round(coords),axis=1)))
        score=covariance_error+.5*grid_error
        proposals.append({'score':score,'covariance_error':covariance_error,'grid_error':grid_error,'basis':[A.tolist(),B.tolist()],'pair_support':[len(clusters[i]),len(clusters[j])]})
    if not proposals:return {'ok':False,'reason':'No nonparallel stud-grid basis supported'}
    proposals.sort(key=lambda p:p['score']);best=proposals[0]
    A,B=map(np.asarray,best['basis'])
    # Fix a reproducible upright gauge: x projects down-right and z down-left.
    if A[1]>B[1]:A,B=B,A
    Mx=B/20;Mz=-A/20
    C=np.outer(Mx,Mx)+np.outer(Mz,Mz)
    values,vectors=np.linalg.eigh(C)
    My=np.sqrt(max(0,values[1]-values[0]))*vectors[:,0]
    if My[1]<0:My=-My
    matrix=np.column_stack((Mx,My,Mz))
    ok=best['covariance_error']<.30 and best['grid_error']<.18
    return {'ok':bool(ok),'matrix':matrix.tolist(),'best':best,'alternatives':proposals[1:5],
            'detected_studs':len(detections),'observed_ellipse_covariance':covariance.tolist(),
            'score_margin':float(proposals[1]['score']-best['score']) if len(proposals)>1 else None,
            'reason':'Image-only orthographic inference' if ok else 'Inconsistent grid/ellipse evidence',
            'limitations':['Orthographic assumption','Gauge signs fixed upright; yaw ambiguity remains','Stud semantic identity and visibility not certified','12 LDU cap diameter / 20 LDU grid prior']}


def infer_camera_robust(detections, grid_tolerance=.10, min_inliers=4):
    """Infer from a supported coplanar subset, retaining off-grid uncertainty.

    Never edits image pixels or removes a color. Proposals originate in actual
    pair differences; four consistent detections are required. Multiple planes
    sharing a camera may have different image-grid origins.
    """
    n=len(detections)
    if n<min_inliers:return {'ok':False,'reason':'At least four ellipse detections required','detected_studs':n}
    centers=np.array([p['center'] for p in detections],float)
    major=float(np.median([max(p['axes']) for p in detections]))
    clusters=[]
    for a,b in itertools.combinations(centers,2):
        v=b-a
        if v[0]<0:v=-v
        if not .65*major<=np.linalg.norm(v)<=2.2*major:continue
        for cluster in clusters:
            if np.linalg.norm(v-np.mean(cluster,axis=0))<max(1.5,.07*major):cluster.append(v);break
        else:clusters.append([v])
    means=[np.mean(c,axis=0) for c in clusters]
    subsets=set()
    for A,B in itertools.combinations(means,2):
        basis=np.column_stack((A,B))
        if abs(np.linalg.det(basis))<.2*np.linalg.norm(A)*np.linalg.norm(B):continue
        coordinates=centers@np.linalg.inv(basis).T
        for anchor in coordinates:
            residual=np.linalg.norm((coordinates-anchor)-np.round(coordinates-anchor),axis=1)
            indices=tuple(np.flatnonzero(residual<=grid_tolerance))
            if len(indices)>=min_inliers:subsets.add(indices)
    candidates=[]
    for indices in subsets:
        inferred=infer_camera([detections[i] for i in indices])
        if not inferred['ok']:continue
        inferred.update(inlier_indices=list(map(int,indices)),inlier_count=len(indices),support_fraction=len(indices)/n,
                        outlier_indices=[i for i in range(n) if i not in indices])
        candidates.append(inferred)
    if not candidates:return {'ok':False,'reason':'No four-point grid consistent with ellipse scale','detected_studs':n}
    candidates.sort(key=lambda r:(-r['inlier_count'],r['best']['score']))
    winner=candidates[0]
    winner.update(detected_studs=n,robust=True,grid_tolerance_studs=grid_tolerance,
                  candidate_subsets=len(candidates),ambiguity=[{'inlier_count':r['inlier_count'],'score':r['best']['score'],'matrix':r['matrix']} for r in candidates[1:4]])
    winner['limitations']+=['Outliers may be other planes or misdetections; no semantic rejection','Support fraction is calibration evidence, not model accuracy']
    return winner


def infer_camera_row(detections):
    """Use a collinear stud row plus cap ellipses to recover the second axis.

    Missing-axis outer product follows from cap covariance and universal
    diameter/pitch ratio. This leaves sign/gauge ambiguity, explicitly fixed
    to an upright camera. Not used by the default inference API.
    """
    if len(detections)<3:return {'ok':False,'reason':'Need at least three row detections'}
    centers=np.array([p['center'] for p in detections],float)
    center=centers.mean(0);_,_,vh=np.linalg.svd(centers-center,full_matrices=False);axis=vh[0]
    if axis[0]<0:axis=-axis
    across=(centers-center)@np.array([-axis[1],axis[0]])
    covariance=[]
    for p in detections:
        angle=np.radians(p['angle']);R=np.array([[np.cos(angle),-np.sin(angle)],[np.sin(angle),np.cos(angle)]])
        covariance.append(R@np.diag(np.array(p['axes'])**2)@R.T)
    E=np.median(covariance,axis=0);major=np.sqrt(np.linalg.eigvalsh(E).max())
    if np.max(np.abs(across))>.10*major:return {'ok':False,'reason':'Detections are not one consistent row'}
    along=np.sort((centers-center)@axis);gaps=np.diff(along);gaps=gaps[gaps>.2*major]
    if len(gaps)<2:return {'ok':False,'reason':'Insufficient distinct row spacings'}
    candidates=[]
    for pitch in sorted(set(float(g/k) for g in gaps for k in [1,2,3])):
        if not .65*major<pitch<2.2*major:continue
        A=axis*pitch;remaining=E/.36-np.outer(A,A);values,vectors=np.linalg.eigh(remaining)
        if values[1]<=0:continue
        B=vectors[:,1]*np.sqrt(values[1]);rank_error=abs(float(values[0]))/values[1]
        grid_error=float(np.mean(np.abs((along-along[0])/pitch-np.round((along-along[0])/pitch))))
        if A[1]>=0:
            if B[0]>0:B=-B
            Mx,Mz=A/20,B/20
        else:
            if B[0]<0:B=-B
            Mx,Mz=B/20,-A/20
        if min(Mx[1],Mz[1])<0:continue
        C=np.outer(Mx,Mx)+np.outer(Mz,Mz);v,w=np.linalg.eigh(C);My=w[:,0]*np.sqrt(max(0,v[1]-v[0]))
        if My[1]<0:My=-My
        matrix=np.column_stack((Mx,My,Mz));candidates.append({'matrix':matrix.tolist(),'rank1_residual':rank_error,'row_grid_error':grid_error,'stud_pitch_pixels':pitch,'score':rank_error+grid_error})
    if not candidates:return {'ok':False,'reason':'No physically consistent ellipse/row factorization'}
    candidates.sort(key=lambda r:r['score']);best=candidates[0]
    return {'ok':best['rank1_residual']<.25 and best['row_grid_error']<.10,**best,
            'detected_studs':len(detections),'method':'Single-row spacing plus ellipse covariance rank-one factorization',
            'limitations':['Orthographic and circular12LDUcap assumptions','Signs fixed upright; yaw and handedness require scene context','Rank-one residual reports segmentation/model error'],
            'alternatives':candidates[1:4]}


if __name__=='__main__':
    root=Path('output/pdf-placement-diagnosis/studs')
    data=json.loads((root/'detections.json').read_text())
    results=[{k:r[k] for k in ('page','xref','component')}|{'camera':infer_camera(r['detections'])} for r in data['records']]
    (root/'cameras.json').write_text(json.dumps(results,indent=2))
    print(root/'cameras.json')
