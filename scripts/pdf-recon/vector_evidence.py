"""Audit PDF artwork serialization and export deterministic scene proposals.

PDF input only. Proposals are diagnostics, not ground-truth panel labels.
No learned models, VLM, inventory or reconstructed/ground-truth geometry.
"""
import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
import re

import pymupdf
from PIL import Image, ImageDraw


def inspect(path, out):
    doc = pymupdf.open(path)
    result = {'pdf': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
              'pages': [], 'limitations': ['Scene proposals are heuristic and unverified.',
              'Image transforms are 2D PDF placement transforms, not 3D part poses.',
              'Indexed images may contain real artwork as well as arrows.']}
    digest_pages = defaultdict(set)
    examples = []
    for index, page in enumerate(doc):
        words = page.get_text('words')
        qty = [w for w in words if re.fullmatch(r'\d+x', w[4])]
        large_ids = [w for w in words if re.fullmatch(r'\d{6,8}', w[4])]
        drawings = page.get_drawings()
        # Callout containers are vector rectangles with quantity labels inside.
        containers = []
        for drawing in drawings:
            box = drawing['rect']
            if 20 < box.width < .92*page.rect.width and 20 < box.height < .65*page.rect.height:
                if any(box.contains(pymupdf.Point((w[0]+w[2])/2, (w[1]+w[3])/2)) for w in qty):
                    if not any(abs(box.x0-b.x0)+abs(box.y0-b.y0)+abs(box.x1-b.x1)+abs(box.y1-b.y1)<5 for b in containers):
                        containers.append(box)
        images = []
        for item in page.get_image_info(hashes=True, xrefs=True):
            box = pymupdf.Rect(item['bbox'])
            center = (box.tl+box.br)/2
            near_quantity = any(w[1] >= box.y1-3 and w[1] <= box.y1+15 and
                                w[0] >= box.x0-10 and w[0] <= box.x1+10 for w in qty)
            inside_callout = any(b.contains(center) for b in containers)
            proposed = (len(large_ids)<5 and min(box.width,box.height)>35 and
                        not near_quantity and not inside_callout and
                        box.get_area()<.80*page.rect.get_area() and item['colorspace']==3)
            row = {k: item[k] for k in ('xref','bbox','transform','width','height','colorspace','cs-name')}
            row.update(digest=item['digest'].hex(), near_quantity=near_quantity,
                       inside_callout=inside_callout, scene_proposal=proposed)
            images.append(row)
            digest_pages[row['digest']].add(index+1)
        result['pages'].append({'page':index+1, 'image_count':len(images),
            'vector_path_count':len(drawings), 'form_xobject_count':len(page.get_xobjects()),
            'quantity_count':len(qty), 'inventory_like':len(large_ids)>=5,
            'callout_containers':[list(b) for b in containers], 'images':images})
        if 2 <= index <= 9:
            pix=page.get_pixmap(matrix=pymupdf.Matrix(1.5,1.5), alpha=False)
            im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
            draw=ImageDraw.Draw(im)
            for j,row in enumerate(images):
                if row['scene_proposal']:
                    box=[v*1.5 for v in row['bbox']]
                    draw.rectangle(box,outline='red',width=2)
                    draw.text((box[0],box[1]),f"scene {j}: {row['width']}x{row['height']}",fill='red')
                    # Native RGB scene exported without re-rendering / page text.
                    if row['xref']:
                        raw=doc.extract_image(row['xref'])
                        (out/f'p{index+1:02d}-image{j}.{raw["ext"]}').write_bytes(raw['image'])
            draw.text((3,3),f'PDF page {index+1}',fill='black')
            examples.append(im)
    result['summary'] = {'pages':len(doc), 'images':sum(p['image_count'] for p in result['pages']),
        'vector_paths':sum(p['vector_path_count'] for p in result['pages']),
        'form_xobjects':sum(p['form_xobject_count'] for p in result['pages']),
        'quantity_pages':sum(p['quantity_count']>0 for p in result['pages']),
        'scene_proposals':sum(sum(i['scene_proposal'] for i in p['images']) for p in result['pages']),
        'quantity_pages_with_scene':sum(p['quantity_count']>0 and any(i['scene_proposal'] for i in p['images']) for p in result['pages']),
        'cross_page_reused_image_digests':sum(len(v)>1 for v in digest_pages.values())}
    result['reused_images']={k:sorted(v) for k,v in digest_pages.items() if len(v)>1}
    (out/'evidence.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    if examples:
        w=max(x.width for x in examples);h=max(x.height for x in examples)
        sheet=Image.new('RGB',(w*2,h*((len(examples)+1)//2)),'white')
        for i,im in enumerate(examples):sheet.paste(im,((i%2)*w,(i//2)*h))
        sheet.save(out/'scene-proposals.png')
    doc.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('pdf',type=Path)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    inspect(args.pdf,args.out)
