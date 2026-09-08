"""Partial-body material registration; retains camera/translation ambiguity.

Native PDF evidence plus already reconstructed body only. No reference poses.
Scores visible known-color template precision; future/occluding geometry can
invalidate this approximation, so output is never a certified camera lock.
"""
import argparse,hashlib,json
from pathlib import Path
import cv2
import numpy as np
from placement_beam import rotations
from placement_arrow_contacts import read_items
from placement_cuda_layers import LayerRasterizer
from placement_gpu_colored_scene_score import GpuColoredSceneScorer
from placement_palette_classes import palette_labels
from placement_colored_cad import _rgb


def register(scene,base,M,stable_colors=(1,4),per_camera=3):
    scorer=GpuColoredSceneScorer(scene,plane_depth=True);raster=LayerRasterizer();M=np.asarray(M,float)
    palette=np.stack([_rgb(c) for c in stable_colors]).astype(np.uint8)
    target,_=palette_labels(scene['rgb'],scene['mask'],palette);rows=[]
    for ri,G in enumerate(rotations()):
        projection=M@G[:3,:3];triangles=[];paints=[];actual_codes=set()
        for part,color,T in base:
            data=scorer._project_part(part,color,T,projection)
            xy=data['xy']+projection@T[:3,3];z=data['vertex_depth']+data['camera']@T[:3,3]
            triangles.append(np.concatenate((xy,z[:,:,None]),2))
            codes=scorer.geometry[(part,str(color))]['colors'];actual_codes.update(map(int,codes));paint=np.zeros((len(codes),3),np.uint8)
            for ci,c in enumerate(stable_colors):paint[codes==c,0]=ci+1
            paints.append(paint)
        tri=np.concatenate(triangles);paint=np.concatenate(paints)
        low=np.floor(tri[:,:,:2].min((0,1)))-2;high=np.ceil(tri[:,:,:2].max((0,1)))+2;size=(high-low).astype(int)
        tri[:,:,:2]-=low
        rendered=raster.render_depth(tri[None],paint[None],int(size[0]),int(size[1]))
        label=np.where(rendered['mask'][0],rendered['rgb'][0,:,:,0],0)
        # Full translation lattice including partly out-of-image templates;
        # zero padding preserves false-positive penalties for those pixels.
        padding=max(label.shape);scores=None;counts={};expected=[ci for ci,c in enumerate(stable_colors) if c in actual_codes and int(np.sum(target==ci+1))>=8]
        for ci,c in enumerate(stable_colors):
            if ci not in expected:continue
            template=(label==ci+1).astype(np.float32);count=int(template.sum())
            counts[str(c)]=count
            if count<8:continue
            padded=np.pad((target==ci+1).astype(np.float32),padding)
            match=cv2.matchTemplate(padded,template,cv2.TM_CCORR)/count
            scores=match if scores is None else scores+match
        if scores is None:continue
        # A known printed color visible in the PDF but hidden by a candidate
        # view contributes zero; it must not disappear from the denominator.
        scores/=len(expected)
        for _ in range(per_camera):
            y,x=np.unravel_index(np.argmax(scores),scores.shape);value=float(scores[y,x])
            rows.append(dict(score=value,projection=projection.tolist(),rotation_index=ri,
                origin=(np.array([x,y])-padding-low).tolist(),source_material_pixels=counts))
            scores[max(0,y-4):y+5,max(0,x-4):x+5]=-1
    rows.sort(key=lambda r:-r['score'])
    top=rows[0]['score'];near=[r for r in rows if r['score']>=top-.02]
    origins=np.asarray([r['origin'] for r in near])
    return dict(hypotheses=rows,near_best_count=len(near),near_best_origin_bounds=[origins.min(0).tolist(),origins.max(0).tolist()],truth_used=False,certified=False,
        protocol='Equal supported stable-material template precision, fixed native physical scale, exhaustive integer translation,24proper camera orientations; retain near-best alternatives',
        limitations='Partial-body known pixels may be occluded by later additions; not a calibrated posterior or certified registration. Origin bounds across different camera orientations are descriptive only.')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--pdf',required=True,type=Path);p.add_argument('--page',required=True,type=int);p.add_argument('--base',required=True,type=Path);p.add_argument('--camera-audit',required=True,type=Path);p.add_argument('--out',required=True,type=Path);args=p.parse_args()
    import pymupdf
    from vector_scene import scene_images
    audit=json.loads(args.camera_audit.read_text());evidence=next(r for r in audit['native_scenes'] if r['page']==args.page)
    assert audit['pdf_sha256']==hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    source=json.loads((args.base.parent/'results.json').read_text())
    if source.get('truth_used') is not False or source.get('runtime_vlm_calls')!=0 or source.get('pdf_sha256')!=audit['pdf_sha256']:
        raise ValueError('Existing-body cache lacks matching PDF/zero-VLM/truth-free provenance')
    M=evidence['multirow']['hypotheses'][0]['matrix']
    with pymupdf.open(args.pdf) as doc:scene=next(s for s in scene_images(doc,doc[args.page]) if s['xref']==evidence['xref'])
    result=register(scene,read_items(args.base),M);result.update(pdf=str(args.pdf),pdf_sha256=audit['pdf_sha256'],page=args.page,xref=evidence['xref'],base=str(args.base),base_sha256=hashlib.sha256(args.base.read_bytes()).hexdigest(),runtime_vlm_calls=0)
    args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(json.dumps(result,indent=2));print(json.dumps(dict(best=result['hypotheses'][0],near_best_count=result['near_best_count'])))
