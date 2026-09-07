"""PDF-only camera hypotheses from several independent collinear stud rows.

Pair-seeded row consensus keeps different height planes separate. Each row is
calibrated by spacing + cap ellipse covariance; compatible physical matrices
are grouped without forcing incompatible rows into one grid.
"""
import argparse
import itertools
import json
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from placement_studs import detect_studs
from placement_camera import infer_camera_row
from vector_scene import scene_images


def row_camera_hypotheses(scene,min_row_points=3,row_tolerance=.10,matrix_tolerance=.08):
    rgb=scene['rgb'];mask=scene['mask'];candidates=[]
    value=np.repeat(rgb.max(axis=2)[:,:,None],3,axis=2)
    detections=[]
    for channel,image in [('gray',rgb),('value',value)]:
        for detection in detect_studs(image,mask):
            item=dict(detection,channel=channel)
            match=next((i for i,p in enumerate(detections) if np.linalg.norm(np.asarray(item['center'])-p['center'])<2),None)
            if match is None:detections.append(item)
            elif item['confidence']>detections[match]['confidence']:detections[match]=item
    if len(detections)<min_row_points:return dict(detections=detections,rows=[],hypotheses=[],reason='Insufficient ellipses')
    centers=np.asarray([p['center'] for p in detections]);major=float(np.median([max(p['axes']) for p in detections]))
    subsets=set()
    for i,j in itertools.combinations(range(len(centers)),2):
        direction=centers[j]-centers[i];length=np.linalg.norm(direction)
        if length<.6*major:continue
        direction/=length;normal=np.array([-direction[1],direction[0]])
        support=tuple(map(int,np.flatnonzero(np.abs((centers-centers[i])@normal)<=row_tolerance*major)))
        if len(support)>=min_row_points:subsets.add(support)
    rows=[]
    for support in sorted(subsets,key=lambda s:(-len(s),s)):
        covariances=[]
        for index in support:
            p=detections[index];angle=np.radians(p['angle']);R=np.array([[np.cos(angle),-np.sin(angle)],[np.sin(angle),np.cos(angle)]])
            covariances.append(R@np.diag(np.asarray(p['axes'])**2)@R.T)
        median=np.median(covariances,axis=0)
        dispersion=max(np.linalg.norm(c-median)/max(1e-8,np.linalg.norm(median)) for c in covariances)
        # A row of equal physical stud caps under one orthographic camera must
        # share ellipse shape. Mixing tiny cylinder details with full studs
        # otherwise creates convincing but geometrically impossible rows.
        if dispersion>.20:continue
        result=infer_camera_row([detections[i] for i in support])
        if result['ok']:rows.append(dict(indices=list(support),ellipse_dispersion=float(dispersion),inference=result))
    # Overlapping subsets of a longer accepted row are not independent votes.
    maximal=[]
    for row in rows:
        if any(set(row['indices']).issubset(r['indices']) for r in maximal):continue
        maximal.append(row)
    groups=[]
    for row in maximal:
        matrix=np.asarray(row['inference']['matrix'])
        group=next((g for g in groups if np.linalg.norm(matrix-g['matrix'])/max(1e-8,np.linalg.norm(g['matrix']))<=matrix_tolerance),None)
        if group is None:groups.append(dict(matrix=matrix,rows=[row]));continue
        group['rows'].append(row)
        # Keep an actually inferred physical matrix as medoid, not an average
        # that might violate orthographic constraints.
        matrices=[np.asarray(r['inference']['matrix']) for r in group['rows']]
        cost=[sum(np.linalg.norm(a-b) for b in matrices) for a in matrices]
        group['matrix']=matrices[int(np.argmin(cost))]
    for group in groups:
        indices=sorted(set(i for row in group['rows'] for i in row['indices']))
        candidates.append(dict(matrix=group['matrix'].tolist(),row_count=len(group['rows']),
            supported_ellipses=len(indices),indices=indices,
            mean_row_residual=float(np.mean([r['inference']['score'] for r in group['rows']])),
            row_indices=[r['indices'] for r in group['rows']],certified=False))
    candidates.sort(key=lambda c:(-c['supported_ellipses'],-c['row_count'],c['mean_row_residual']))
    return dict(detections=detections,rows=maximal,hypotheses=candidates,
        limitations=['Ellipse proposals may be holes or decoration.',
            'Rows on different planes can share a camera; compatible does not prove semantic correspondence.',
            'Signed axis gauge and assembly yaw remain unresolved.',
            'No matrix is forced when independent row hypotheses disagree.'])


def diagnostic(out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf');records=[]
    sheet=Image.new('RGB',(1200,450),'#eeeeee');draw=ImageDraw.Draw(sheet)
    for column,page in enumerate((4,5,6)):
        scene=scene_images(doc,doc[page])[0]
        result=row_camera_hypotheses(scene);records.append(dict(page=page,xref=scene['xref'],**result))
        im=Image.fromarray(scene['rgb']).resize((scene['rgb'].shape[1]*2,scene['rgb'].shape[0]*2));d=ImageDraw.Draw(im)
        palette=['magenta','cyan','orange','lime']
        for i,row in enumerate(result['rows']):
            points=[np.asarray(result['detections'][j]['center'])*2 for j in row['indices']]
            for point in points:d.ellipse((point[0]-4,point[1]-4,point[0]+4,point[1]+4),outline=palette[i%4],width=2)
            if len(points)>1:d.line([tuple(min(points,key=lambda p:p[0])),tuple(max(points,key=lambda p:p[0]))],fill=palette[i%4],width=1)
        im.thumbnail((390,390));sheet.paste(im,(column*400,45));draw.text((column*400+3,3),f'printed{page+1}: {len(result["rows"])} rows / {len(result["hypotheses"])} cameras',fill='black')
    sheet.save(out/'row-cameras.png')
    (out/'results.json').write_text(json.dumps(records,indent=2),encoding='utf-8')


def selftest(out):
    import cv2
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    image=np.full((190,180,3),(210,235,250),np.uint8);mask=np.zeros(image.shape[:2],np.uint8)
    for row in range(2):
        for i in range(4):
            center=(30+i*22,30+i*11+row*70)
            cv2.ellipse(image,center,(9,4),0,0,360,(0,0,0),-1)
            cv2.ellipse(mask,center,(9,4),0,0,360,1,-1)
    result=row_camera_hypotheses(dict(rgb=image,mask=mask>0))
    (out/'synthetic-rows.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    cv2.imwrite(str(out/'synthetic-rows.png'),cv2.cvtColor(image,cv2.COLOR_RGB2BGR))
    assert result['hypotheses'] and result['hypotheses'][0]['supported_ellipses']==8
    assert result['hypotheses'][0]['row_count']>=2


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args();selftest(args.out);diagnostic(args.out)
