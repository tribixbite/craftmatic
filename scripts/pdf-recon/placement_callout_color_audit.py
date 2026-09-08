"""Native callout/BOM color audit; no set poses and no assignment mutation."""
import json,sys,hashlib
from pathlib import Path
import cv2,numpy as np,pymupdf
from PIL import Image,ImageDraw
sys.path.insert(0,'C:/git/clego')
from recon_extract import extract_e4 as e4
from pdf_crop_trial import artwork_pixels


def descriptor(rgb):
    rgb=np.asarray(rgb,np.uint8);edge=np.concatenate((rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]))
    unique,counts=np.unique(edge,axis=0,return_counts=True);background=unique[np.argmax(counts)]
    foreground=np.max(np.abs(rgb.astype(float)-background),axis=2)>18
    neutral=(rgb.max(2).astype(int)-rgb.min(2).astype(int))<28
    pixels=rgb.max(2)[foreground&neutral]
    return dict(background=background.tolist(),foreground_pixels=int(foreground.sum()),neutral_pixels=len(pixels),
        neutral_fraction=float(len(pixels)/max(1,foreground.sum())),value_quantiles=np.quantile(pixels,[.25,.5,.75,.9]).tolist() if len(pixels) else [],
        bright_fraction=float(np.mean(pixels>210)) if len(pixels) else None,dark_fraction=float(np.mean(pixels<110)) if len(pixels) else None)


if __name__=='__main__':
    src=Path('output/pdf-placement-diagnosis/40377-slot-assignment-v1/slot-assignment.json');data=json.loads(src.read_text());out=Path('output/pdf-placement-diagnosis/callout-color-swap');out.mkdir(exist_ok=True)
    doc=pymupdf.open(data['pdf']);rows=[];images=[]
    chosen=[r for r in data['evidence'] if r['page']==23 or r['page']==31 and r['part']=='3031']
    for r in chosen:
        rgb=e4.render_page(doc,r['page']);clean=artwork_pixels(rgb,doc[r['page']].get_text('words'),e4.ERA4.pli_bg);x0,y0,x1,y1=r['bbox'];image=clean[y0:y1,x0:x1]
        rows.append(dict(kind='callout',page=r['page'],assigned=r['part'],color=r['color'],score=r['score'],descriptor=descriptor(image)));images.append(image)
    for slot in data['slots']:
        if not any(c['part'] in ('3031','3958') for c in slot['choices']):continue
        pix=doc[slot['source_page']].get_pixmap(matrix=pymupdf.Matrix(4,4),clip=pymupdf.Rect(slot['icon_bbox']),alpha=False);image=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3]
        rows.append(dict(kind='BOM',choices=slot['choices'],descriptor=descriptor(image)));images.append(image)
    sheet=Image.new('RGB',(350*len(images),260),'white');draw=ImageDraw.Draw(sheet)
    for index,(row,img) in enumerate(zip(rows,images)):
        im=Image.fromarray(img);im.thumbnail((330,200));im=im.resize((int(im.width*min(330/im.width,200/im.height)),int(im.height*min(330/im.width,200/im.height))));sheet.paste(im,(350*index,45));draw.text((350*index+4,3),str({k:v for k,v in row.items() if k!='descriptor'}),fill='black')
    sheet.save(out/'comparison.png')
    from placement_pdf_color_constraints import constrain_scores
    constrained,evidence=constrain_scores(images[:2],images[2:],np.ones((2,2)))
    assert np.isfinite(constrained[0,0]) and not np.isfinite(constrained[0,1])
    assert np.isfinite(constrained[1,1]) and not np.isfinite(constrained[1,0])
    (out/'results.json').write_text(json.dumps(dict(pdf_sha256=data['pdf_sha256'],assignment_sha256=hashlib.sha256(src.read_bytes()).hexdigest(),rows=rows,color_constraint_evidence=evidence,truth_used=False,runtime_vlm_calls=0),indent=2));print(json.dumps(rows))
