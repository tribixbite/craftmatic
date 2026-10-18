"""Independent PDF-only bootstrap diagnostic for 41624; no hue erasure."""
import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
from PIL import Image,ImageDraw
from vector_scene import scene_images
from placement_studs import detect_studs
from placement_camera import infer_camera_robust

out=Path('output/pdf-placement-vector/second-fixture');out.mkdir(parents=True,exist_ok=True)
pdf=Path('C:/git/clego/lego_sets/PDF/6248865.pdf');doc=pymupdf.open(pdf)
journal_path=Path('output/pdf-crop-trial-v2/41624-cnn-contact/journal.json')
journal=json.loads(journal_path.read_text());by_page={r['page']:r for r in journal}
records=[];sheet=Image.new('RGB',(1600,1600),'#eeeeee');draw=ImageDraw.Draw(sheet)
for page in range(2,12):
    scenes=scene_images(doc,doc[page]);scene_records=[]
    for index,scene in enumerate(scenes):
        detections=detect_studs(scene['rgb'],scene['mask'])
        inferred=infer_camera_robust(detections)
        # Diagnostic dark-outline isolation: grayscale luminance makes saturated
        # red faces almost as dark as black outlines. HSV value/maxRGB keeps
        # those faces bright without deleting any hue or changing geometry.
        value=scene['rgb'].max(axis=2)
        value_detections=detect_studs(np.repeat(value[:,:,None],3,axis=2),scene['mask'])
        value_camera=infer_camera_robust(value_detections)
        r,g,b=scene['rgb'].transpose(2,0,1).astype(np.int16)
        red=(r>120)&(r>g+45)&(r>b+45)&scene['mask']
        green=(g>95)&(g>r+25)&(g>b+20)&scene['mask']
        scene_records.append(dict(xref=scene['xref'],inside_panel=scene['inside_panel'],
            red_pixels=int(red.sum()),green_pixels=int(green.sum()),
            native_bbox=scene['bbox'],detections=detections,camera=inferred,
            value_detections=value_detections,value_camera=value_camera))
        if index==0:
            col=(page-2)%4;row=(page-2)//4;x=col*400;y=row*530
            im=Image.fromarray(scene['rgb']);im.thumbnail((390,420));sheet.paste(im,(x,y+80))
            draw.text((x+3,y+3),f'printed {page+1}, xref{scene["xref"]}: camera={inferred["ok"]}',fill='black')
            draw.text((x+3,y+18),f'{len(detections)} ellipse proposals; no hue erasure',fill='black')
            evidence=by_page.get(page,{}).get('parts',{}).get('crop_evidence',[])
            labels=[f'{r.get("qty")}x {r.get("part")}/{r.get("color")}' for r in evidence]
            draw.text((x+3,y+33),'; '.join(labels[:3]),fill='black')
            im.save(out/f'p{page+1}-main.png')
    records.append(dict(page=page,printed_page=page+1,scenes=scene_records,
        pdf_pli_evidence=by_page.get(page,{}).get('parts',{}).get('crop_evidence',[])))
result=dict(protocol='PDF-only geometry/camera; historical PDF-derived PLI hypotheses only; no truth models',
    pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),pli_source=str(journal_path),
    pli_sha256=hashlib.sha256(journal_path.read_bytes()).hexdigest(),
    hue_erasure=False,records=records,
    summary=dict(pages=10,main_camera_accepted=[r['printed_page'] for r in records if r['scenes'] and r['scenes'][0]['camera']['ok']],
        value_camera_accepted=[r['printed_page'] for r in records if r['scenes'] and r['scenes'][0]['value_camera']['ok']]))
(out/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
sheet.save(out/'first-steps.png')
