"""Quantity-anchored PDF artwork crops; experimental, no runtime VLM."""
import argparse
import json
import os
from pathlib import Path
import sys
import cv2
import numpy as np
import pymupdf

BASE=Path('C:/git/clego')
OUT=Path(os.environ.get('PDF_CROP_OUT',str(Path(__file__).resolve().parents[2]/'output/pdf-crop-trial')))
sys.path.insert(0,str(BASE))


def unique_quantities(quantities):
    """Collapse identical overprinted PDF quantities, preserving distinct labels."""
    seen=set()
    for quantity in quantities:
        key=(quantity['qty'],tuple(quantity['bbox']))
        if key not in seen:
            seen.add(key)
            yield quantity


def crop_items(rgb, words, quantities, background, scale=1.6):
    """Find local components ABOVE each quantity, excluding all PDF text.

    Unlike x-only partitioning, this cannot assign a step digit or artwork
    from a lower row to a quantity merely because it shares the same x.
    Returns rejected/ambiguous anchors explicitly; no inventory fallback.
    """
    mask=(np.abs(rgb.astype('int16')-np.asarray(background,dtype='int16')).sum(2)>90).astype('uint8')
    textmask=np.zeros(mask.shape,dtype='uint8')
    for word in words:
        x0,y0,x1,y1=[int(round(v*scale)) for v in word[:4]]
        textmask[max(0,y0-1):y1+2,max(0,x0-1):x1+2]=1
    mask[textmask>0]=0
    # Even-sized morphology kernels shift components by a pixel. That broke
    # the quantity-edge test on legitimate artwork touching its label baseline.
    # An odd kernel preserves coordinates; never refill masked text afterward.
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    mask[textmask>0]=0
    n,labels,stats,_=cv2.connectedComponentsWithStats(mask,8)
    candidates=[]
    for i in range(1,n):
        x,y,w,h,area=map(int,stats[i])
        if area<12 or min(w,h)<3 or max(w,h)>320 or w*h>40000:
            continue
        if max(w,h)/min(w,h)>35:
            continue
        py,px=np.where(labels[y:y+h,x:x+w]==i)
        candidates.append((i,(x,y,x+w,y+h),area,px+x,py+y))
    out=[]
    for q in unique_quantities(quantities):
        qx,qy,qright,qbottom=q['bbox']
        options=[]
        for index,box,area,px,py in candidates:
            x0,y0,x1,y1=box
            if y0>=qy or (y0+y1)/2>qy or qy-y0>260:
                continue
            if not x0-24<=qx<=x1+12:
                continue
            # In an isometric drawing the far-right corner can extend BELOW
            # its left-aligned quantity label. Global bbox-bottom distance
            # wrongly rejects such parts. Use the nearest actual ink above
            # the label instead, while requiring the part's centre above it.
            above=py<=qy+2
            if not above.any(): continue
            distance=float(np.sqrt(((px[above]-qx)**2+(py[above]-qy)**2).min()))
            if distance>max(24,2*(qbottom-qy)): continue
            options.append((distance,index,box,area))
        options.sort()
        if not options:
            out.append({'qty':q['qty'],'anchor':list(q['bbox']),'unresolved':'no nearby nontext artwork'})
            continue
        if len(options)>1 and options[1][0]-options[0][0]<3:
            out.append({'qty':q['qty'],'anchor':list(q['bbox']),'unresolved':'ambiguous artwork association'})
            continue
        score,index,box,area=options[0]
        out.append({'qty':q['qty'],'anchor':list(q['bbox']),'bbox':list(box),'component':index,'association_cost':score})
    claimed={}
    for r in out:
        if 'component' in r: claimed.setdefault(r['component'],[]).append(r)
    for group in claimed.values():
        if len(group)>1:
            for r in group:
                r.pop('bbox',None)
                r['unresolved']='same artwork claimed by multiple quantities'
    return out


def artwork_pixels(rgb,words,background,scale=1.6):
    """Remove PDF text from the matcher input as well as segmentation.

    A long beam's bounding rectangle can enclose an unconnected length label.
    Masking only during component finding leaves that text in the final crop.
    """
    clean=rgb.copy()
    for word in words:
        x0,y0,x1,y1=[int(round(v*scale)) for v in word[:4]]
        clean[max(0,y0-1):y1+2,max(0,x0-1):x1+2]=background
    return clean


def run(sets):
    from recon_extract import extract_e4 as e4
    from recon_extract.pdf_inventory import is_inventory_page
    from recon_v7 import pdfpick
    OUT.mkdir(parents=True,exist_ok=True)
    pdfpick.CACHE=OUT/'pdfpick.json'
    result=[]
    tiles=[]
    for sn in sets:
        pdf,_=pdfpick.pick(sn)
        with pymupdf.open(pdf) as doc:
            for pg in range(len(doc)):
                if is_inventory_page(doc[pg]): continue
                tokens=e4.page_tokens(doc,pg,style=e4.ERA4)
                qty=tokens['qty_small']
                if not qty: continue
                rgb=e4.render_page(doc,pg)
                old=e4.page_pli_items(rgb,e4.find_pli_boxes(rgb,style=e4.ERA4),qty,style=e4.ERA4)
                new=crop_items(rgb,doc[pg].get_text('words'),qty,e4.ERA4.pli_bg)
                result.append({'set':sn,'page':pg,'pdf':str(pdf),'old':old,'new':new,
                               'raw_quantity_tokens':len(qty)})
                # Deterministic samples across pages, including known bad
                # digit-crop pages. Both output crops are shown with context.
                if pg not in (2,7,8,14,24): continue
                for r in new[:3]:
                    if 'bbox' not in r: continue
                    qx,qy,_,_=r['anchor']
                    prev=min(old,key=lambda b:abs(b['bbox'][0]-qx)+abs(b['bbox'][3]-qy)) if old else None
                    tile=np.full((160,320,3),255,np.uint8)
                    for col,box in enumerate([prev['bbox'] if prev else None,r['bbox']]):
                        if box is None: continue
                        x0,y0,x1,y1=map(int,box)
                        crop=rgb[y0:y1,x0:x1]
                        if not crop.size: continue
                        ratio=min(150/crop.shape[1],120/crop.shape[0])
                        crop=cv2.resize(crop,(max(1,int(crop.shape[1]*ratio)),max(1,int(crop.shape[0]*ratio))))
                        tile[:crop.shape[0],col*160:col*160+crop.shape[1]]=crop
                    cv2.putText(tile,f'{sn} p{pg} {r["qty"]}x old | anchored',(4,145),cv2.FONT_HERSHEY_SIMPLEX,.42,(0,0,0),1)
                    tiles.append(tile)
        print(sn,'complete',flush=True)
    report={'rows':result,'old_crops':sum(len(r['old']) for r in result),
            'association_version':'v5-unique-quantity-anchors',
            'raw_quantity_tokens':sum(r['raw_quantity_tokens'] for r in result),
            'anchors':sum(len(r['new']) for r in result),
            'resolved_crops':sum('bbox' in i for r in result for i in r['new']),
            'runtime_vlm_calls':0,'limitations':'Crop counts are not precision/recall; association remains experimental'}
    (OUT/'results.json').write_text(json.dumps(report,indent=2,default=lambda x:x.item() if isinstance(x,np.generic) else list(x)))
    for start in range(0,len(tiles),24):
        batch=tiles[start:start+24]
        canvas=np.full((((len(batch)+2)//3)*160,960,3),255,np.uint8)
        for i,t in enumerate(batch): canvas[(i//3)*160:(i//3+1)*160,(i%3)*320:(i%3+1)*320]=t
        cv2.imwrite(str(OUT/f'comparison-{start//24}.png'),cv2.cvtColor(canvas,cv2.COLOR_RGB2BGR))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('sets',nargs='*',default=['41637','42044','42058'])
    args=parser.parse_args()
    run(args.sets)
