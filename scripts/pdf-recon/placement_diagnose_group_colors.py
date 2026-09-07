"""PDF-only fixed color-region ablation, followed by detached prior evaluation."""
from pathlib import Path
import json
import cv2
import numpy as np
import pymupdf
from placement_arrow_contacts import read_items
from placement_colored_cad import nativecolor_render
from placement_part_library import PartLibrary
from vector_scene import scene_images
from vector_scene_components import component_graph
from placement_balanced_color_metric import balanced_color_metric
from placement_colored_cad import _rgb


def regions(rgb,mask):
    hsv=cv2.cvtColor(np.asarray(rgb,np.uint8),cv2.COLOR_RGB2HSV)
    h,s,v=hsv.transpose(2,0,1)
    # Fixed generic blue hue, achromatic white and unknown dark outlines.
    # Printed yellow stays a separate region, not assigned an invented depth.
    return {'blue':mask&(h>=90)&(h<=130)&(s>=65),
            'white':mask&(s<65)&(v>=85),
            'unknown':mask&(s<65)&(v<85)}


def run():
    root=Path('output/pdf-placement-beam/40377-group-nine-v1')
    out=Path('output/pdf-placement-diagnosis/group-nine-color-ablation');out.mkdir(exist_ok=True)
    metadata=json.loads((root/'results.json').read_text())
    with pymupdf.open(metadata['pdf']) as doc:
        scene=scene_images(doc,doc[metadata['page']])[0]
        scene=dict(scene,mask=component_graph(scene)['components'][0]['mask'])
    target=regions(scene['rgb'],scene['mask']);library=PartLibrary();rows=[];images={}
    for rec in metadata['results']:
        rendered=nativecolor_render(read_items(root/rec['file']),rec['projection'],out/rec['file'].replace('.ldr','.png'),origin=rec['evidence']['image_origin'],size=scene['rgb'].shape[1::-1],resolver=library.resolve)
        rr=regions(rendered['rgb'],rendered['mask']);valid=~target['unknown']
        metrics={}
        for color in ('blue','white'):
            a=target[color]&valid;b=rr[color]&valid
            metrics[color+'_iou']=float((a&b).sum()/max(1,(a|b).sum()))
            metrics[color+'_target_pixels']=int(a.sum());metrics[color+'_render_pixels']=int(b.sum())
        metrics['macro_iou']=(metrics['blue_iou']+metrics['white_iou'])/2
        metrics['generic_palette_metric']=balanced_color_metric(scene['rgb'],scene['mask'],rendered['rgb'],rendered['mask'],[1,15],{1:_rgb(1),15:_rgb(15)})
        # Isolate only the existing brightness bug, without changing weights.
        rgb=rendered['rgb'].astype(float);ch=rgb/np.maximum(1,rgb.sum(2,keepdims=True))
        trgb=scene['rgb'].astype(float);tch=trgb/np.maximum(1,trgb.sum(2,keepdims=True))
        achromatic=np.ptp(ch,axis=2)<.045
        match=(np.linalg.norm(ch-tch,axis=2)<.13)&(~achromatic|(np.ptp(tch,axis=2)<.08))
        light=rgb.mean(2)>160;dark=(rgb.mean(2)<70)&achromatic
        compatible=match&(~light|(trgb.mean(2)>110))&(~dark|(trgb.mean(2)<130))
        intersection=rendered['mask']&scene['mask']
        fraction=float((compatible&intersection).sum()/max(1,intersection.sum()))
        metrics['corrected_color_fraction']=fraction
        metrics['brightness_bug_only_score']=.45*rec['evidence']['silhouette_iou']+.35*fraction+.20*rec['evidence']['yellow_iou']
        rows.append(dict(file=rec['file'],runtime_evidence=rec['evidence'],**metrics))
        if rec['file'] in ('beam_00.ldr','beam_10.ldr'):
            overlay=cv2.addWeighted(scene['rgb'],.5,rendered['rgb'],.5,0)
            images[rec['file']]=(rendered['rgb'],overlay)
    result=dict(truth_used=False,runtime_vlm_calls=0,pdf_sha256=metadata['pdf_sha256'],source_page=metadata['page'],source_xref=metadata['xref'],
        protocol='Fixed equal mean of blue/white class IoU; achromatic dark target caps ignored; yellow print omitted from macro. Brightness-only repair separately retains original weights. No label-selected weights.',
        target_unknown_pixels=int(target['unknown'].sum()),rows=rows,
        macro_ranking=[r['file'] for r in sorted(rows,key=lambda r:-r['macro_iou'])],
        brightness_ranking=[r['file'] for r in sorted(rows,key=lambda r:-r['brightness_bug_only_score'])])
    (out/'pdf-only-scores.json').write_text(json.dumps(result,indent=2))
    # Pure coordinate-gauge test: same projected geometry after a global yaw.
    from placement_colored_scene_score import ColoredSceneScorer
    scorer=ColoredSceneScorer(scene);rec=metadata['results'][10]
    items=read_items(root/rec['file']);G=np.eye(4);G[:3,:3]=[[0,0,1],[0,1,0],[-1,0,0]]
    original=scorer.score(items,np.asarray(rec['projection']))
    rotated=scorer.score([(p,c,G@T) for p,c,T in items],np.asarray(rec['projection'])@G[:3,:3].T)
    (out/'coordinate-gauge.json').write_text(json.dumps(dict(truth_used=False,protocol='Universal global yaw plus inverse camera rotation leaves all image points unchanged.',original=original,rotated=rotated),indent=2))
    panels=[]
    for name in ('beam_00.ldr','beam_10.ldr'):
        panel=np.concatenate([scene['rgb'],*images[name]],axis=1)
        panel=cv2.resize(panel,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST)
        panel=cv2.copyMakeBorder(panel,30,0,0,0,cv2.BORDER_CONSTANT,value=(255,255,255))
        cv2.putText(panel,name+' : PDF | own runtime render | 50% overlay',(5,22),cv2.FONT_HERSHEY_SIMPLEX,.6,(0,0,0),1)
        panels.append(panel)
    cv2.imwrite(str(out/'comparison.png'),cv2.cvtColor(np.concatenate(panels,axis=0),cv2.COLOR_RGB2BGR))
    # Only after PDF-only scores are persisted, attach existing independent evaluation.
    prior=json.loads(Path('output/pdf-placement-diagnosis/40377-group-nine-v1-alias-poses.json').read_text())
    (out/'prior-evaluation-copy.json').write_text(json.dumps(prior,indent=2))
    print(json.dumps(result,indent=2))


if __name__=='__main__':run()
