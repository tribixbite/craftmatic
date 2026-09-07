"""Resolve step-callout identity through exact PDF image reuse, no VLM."""
import hashlib
import json
from pathlib import Path
import sys
from collections import defaultdict
import numpy as np
import cv2
import pymupdf

BASE = Path('C:/git/clego')
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf-recon-trials'
sys.path.insert(0, str(BASE))


def overlap(a, b):
    area = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    return area / max((a[2]-a[0])*(a[3]-a[1]), 1e-9)


def main():
    from recon_extract.pdf_inventory import QUANTITY
    data = json.loads((OUT / 'artwork.json').read_text())
    by_pdf = defaultdict(list)
    for r in data['records']:
        by_pdf[r['pdf']].append(r)
    results = []
    for pdf, refs in by_pdf.items():
        with pymupdf.open(pdf) as doc:
            digests = defaultdict(set)
            pages = {r['page'] for r in refs}
            for r in refs:
                for im in doc[r['page']].get_image_info(hashes=True):
                    box = im['bbox']
                    if overlap(box, r['bbox']) >= .95 and 3 <= box[2]-box[0] <= 85 and 3 <= box[3]-box[1] <= 65:
                        digests[im['digest'].hex()].add((r['part'], r['color']))
            known = {k: next(iter(v)) for k,v in digests.items() if len(v)==1}
            rows = []
            for pg in range(len(doc)):
                if pg in pages:
                    continue
                qty = [(w, int(QUANTITY.fullmatch(w[4]).group(1))) for w in doc[pg].get_text('words') if QUANTITY.fullmatch(w[4])]
                for im in doc[pg].get_image_info(hashes=True):
                    ident = known.get(im['digest'].hex())
                    if not ident:
                        continue
                    x0,y0,x1,y1 = im['bbox']
                    near = [(w,n) for w,n in qty if -3 <= w[1]-y1 <= 12 and x0-5 <= w[0] <= x1+5]
                    if len(near) != 1:
                        continue
                    rows.append({'page': pg, 'part': ident[0], 'color': ident[1], 'qty': near[0][1], 'bbox': list(im['bbox'])})
            results.append({'set': refs[0]['set'], 'pdf': pdf, 'labeled_unique_images':len(known), 'callouts':rows})
    report = {'booklets':len(results), 'booklets_with_callouts':sum(bool(r['callouts']) for r in results),
              'callouts':sum(len(r['callouts']) for r in results), 'rows':results,
              'limitations':['Exact artwork reuse transfers the printed element identity; does not solve pose',
                             'Quantity adjacency is a heuristic and must be visually checked',
                             'Vector-only callouts do not use image XObjects'], 'runtime_vlm_calls':0}
    (OUT / 'artwork-reuse-results.json').write_text(json.dumps(report,indent=2))
    # Visual audit of diverse automatically resolved callouts, drawn with their
    # printed quantity and surrounding context, never replacing the source.
    tiles=[]
    for result in results:
        if not result['callouts']:
            continue
        with pymupdf.open(result['pdf']) as doc:
            for r in result['callouts'][:2]:
                box=pymupdf.Rect(r['bbox'])+(-5,-5,10,20)
                pix=doc[r['page']].get_pixmap(matrix=pymupdf.Matrix(3,3),clip=box,alpha=False)
                rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3]
                tile=np.full((155,220,3),255,np.uint8)
                scale=min(210/rgb.shape[1],115/rgb.shape[0])
                im=cv2.resize(rgb,(max(1,int(rgb.shape[1]*scale)),max(1,int(rgb.shape[0]*scale))))
                tile[5:5+im.shape[0],5:5+im.shape[1]]=im
                cv2.putText(tile,f'{result["set"]} p{r["page"]} {r["qty"]}x',(4,134),cv2.FONT_HERSHEY_SIMPLEX,.38,(0,0,0),1)
                cv2.putText(tile,f'{r["part"]} / color {r["color"]}',(4,148),cv2.FONT_HERSHEY_SIMPLEX,.38,(0,0,0),1)
                tiles.append(tile)
                if len(tiles)>=24:
                    break
        if len(tiles)>=24:
            break
    if tiles:
        sheet=np.full((((len(tiles)+3)//4)*155,880,3),255,np.uint8)
        for i,t in enumerate(tiles): sheet[(i//4)*155:(i//4+1)*155,(i%4)*220:(i%4+1)*220]=t
        cv2.imwrite(str(OUT/'reuse-contact-sheet.png'),cv2.cvtColor(sheet,cv2.COLOR_RGB2BGR))
    print(json.dumps({k:v for k,v in report.items() if k!='rows'},indent=2))


if __name__ == '__main__': main()
