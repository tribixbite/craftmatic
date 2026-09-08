"""PDF-only integration checks and native evidence for later attachment batches."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from placement_arrow_contacts import read_items,transformed_connectors
from placement_arrow_mask import conservative_components,protected_cad_colors
from placement_part_library import PartLibrary
from placement_colored_cad import colored_triangles,_rgb
from placement_group_equivalence import geometry_key
from placement_palette_classes import palette_labels
from placement_studs import detect_studs
from placement_camera import infer_camera_row,infer_camera_robust
from placement_multirow_camera import row_camera_hypotheses
from vector_scene import scene_images


def run(pdf,groups,slots,out):
    out.mkdir(parents=True,exist_ok=True);digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
    meta=json.loads((groups/'results.json').read_text());assignment=json.loads(slots.read_text())
    assert meta['pdf_sha256']==assignment['pdf_sha256']==digest
    assert meta['truth_used'] is False and meta['runtime_vlm_calls']==0
    expected=Counter()
    for row in assignment['evidence']:
        if row['page']==11:
            assert len(row['part_choices'])==1
            choice=row['part_choices'][0];expected[(choice['part'],int(choice['color']))]+=row['qty']
    library=PartLibrary();cache={};classes={};records=[];allparts=set()
    for path in sorted(groups.glob('group_*.ldr')):
        items=read_items(path);actual=Counter((p,c) for p,c,T in items)
        key=geometry_key(items,library.resolve,cache);classes.setdefault(key,[]).append(path.name)
        allparts.update(actual)
        records.append(dict(file=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            part_count=len(items),allocated_multiset_exact=actual==expected))
    assert records and all(r['allocated_multiset_exact'] for r in records)
    # Protect all recognized PDF inventory materials, including printed red.
    for row in assignment['evidence']:
        for choice in row['part_choices']:allparts.add((choice['part'],int(choice['color'])))
    palette=protected_cad_colors(sorted(allparts));assert palette['complete']
    scenes_out=[];images=[]
    with pymupdf.open(pdf) as doc:
        for page in (11,12):
            doc[page].get_pixmap(matrix=pymupdf.Matrix(2,2)).save(out/f'page-{page}.png')
            for scene in scene_images(doc,doc[page]):
                if scene['inside_panel']:continue
                graph=conservative_components(scene,palette['rgb']);clean=dict(scene,mask=graph['clean_mask'])
                detections=detect_studs(clean['rgb'],clean['mask']);multi=row_camera_hypotheses(clean)
                # Include all currently allocated base/print colors so blue,
                # white, and yellow artwork cannot be forced into gray/tan.
                current_parts={(c['part'],int(c['color'])) for a in assignment['evidence'] if a['page']<=page for c in a['part_choices']}
                current_palette=protected_cad_colors(sorted(current_parts));codes=current_palette['ldraw_colors']
                labels,_=palette_labels(clean['rgb'],clean['mask'],np.asarray(current_palette['rgb'],np.uint8))
                regions={}
                for color in (19,71):
                    i=codes.index(color) if color in codes else -2
                    m=labels==i+1;y,x=np.where(m)
                    n,cc,stats,centers=cv2.connectedComponentsWithStats(m.astype(np.uint8),8)
                    components=[dict(area=int(stats[j,4]),bbox=list(map(int,stats[j,:4])),center=centers[j].tolist()) for j in range(1,n) if stats[j,4]>=12]
                    components.sort(key=lambda c:-c['area'])
                    regions[str(color)]=dict(pixels=int(m.sum()),bbox=[int(x.min()),int(y.min()),int(x.max()),int(y.max())] if len(x) else None,components=components)
                surrounds=[];yy,xx=np.indices(labels.shape)
                for index,detection in enumerate(detections):
                    cx,cy=detection['center'];a,b=np.asarray(detection['axes'])/2;theta=np.radians(detection['angle'])
                    dx=xx-cx;dy=yy-cy;u=dx*np.cos(theta)+dy*np.sin(theta);v=-dx*np.sin(theta)+dy*np.cos(theta)
                    r=np.sqrt((u/a)**2+(v/b)**2);ring=(r>1.12)&(r<1.55)&clean['mask']
                    counts={str(c):int(((labels==i+1)&ring).sum()) for i,c in enumerate(codes)}
                    surrounds.append(dict(index=index,center=detection['center'],ring_pixels=int(ring.sum()),material_counts=counts))
                row=dict(page=page,xref=scene['xref'],native_size=list(scene['rgb'].shape[:2][::-1]),bbox=list(scene['bbox']),
                    row_camera=infer_camera_row(detections),robust_camera=infer_camera_robust(detections),
                    multirow=multi,detections=detections,arrow_count=len(graph['arrows']),palette_regions=regions,
                    appearance_palette=codes,ellipse_surroundings=surrounds,
                    warnings=['Ellipse proposals include side studs and holes; row matrices retain alternatives.',
                              'Palette regions are appearance evidence, not independent part counts.'])
                scenes_out.append(row)
                im=Image.fromarray(scene['rgb']).resize((scene['rgb'].shape[1]*2,scene['rgb'].shape[0]*2));d=ImageDraw.Draw(im)
                for i,det in enumerate(detections):
                    x,y=np.asarray(det['center'])*2;d.ellipse((x-3,y-3,x+3,y+3),outline='magenta');d.text((x+4,y-4),str(i),fill='magenta')
                im.save(out/f'page-{page}-xref-{scene["xref"]}-ellipses.png');images.append((f'page{page} xref{scene["xref"]}',im))
    cad=colored_triangles('22885',71,resolver=library.resolve);vertices=cad['triangles'].reshape(-1,3)
    connectors={gender:[{k:(v.tolist() if isinstance(v,np.ndarray) else v) for k,v in c.items()} for c in transformed_connectors('22885',np.eye(4),gender)] for gender in ('M','F')}
    report=dict(pdf=str(pdf),pdf_sha256=digest,group_source=str(groups),group_records=records,
        group_geometry_classes=list(classes.values()),group_requirements_pass=True,expected_group_parts=[dict(part=p,color=c,qty=q) for (p,c),q in sorted(expected.items())],
        suggested_target=dict(page=11,xref=116,copies=1,any_anchor=True),native_scenes=scenes_out,
        universal_22885=dict(bounds=[vertices.min(0).tolist(),vertices.max(0).tolist()],triangles=len(cad['triangles']),connectors=connectors,files=cad['files']),
        truth_used=False,runtime_vlm_calls=0,manual_poses=False,certified=False)
    (out/'results.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(dict(group_files=len(records),classes=len(classes),scenes=[dict(page=s['page'],xref=s['xref'],ellipses=len(s['detections']),row_ok=s['row_camera'].get('ok'),robust_ok=s['robust_camera'].get('ok'),multirow_count=len(s['multirow']['hypotheses'])) for s in scenes_out],cad=report['universal_22885']['bounds'],connectors=connectors)))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--pdf',type=Path,required=True);p.add_argument('--groups',type=Path,required=True);p.add_argument('--slots',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.pdf,a.groups,a.slots,a.out)
