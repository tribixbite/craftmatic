"""Show all candidate native scenes in page/reading order."""
import json
from pathlib import Path
import pymupdf
from PIL import Image, ImageDraw
from vector_scene import scene_images

out=Path('output/pdf-placement-vector/40377')
doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf')
sheet=Image.new('RGB',(1200,1200),'#eeeeee')
draw=ImageDraw.Draw(sheet)
records=[]
for row,p in enumerate(range(2,6)):
    candidates=scene_images(doc,doc[p])
    # Column layout convention only; preserve metadata/ranks, no asserted order.
    ordered=sorted(enumerate(candidates),key=lambda z:(z[1]['bbox'][0],z[1]['bbox'][1]))
    for col,(rank,c) in enumerate(ordered[:4]):
        x=col*300;y=row*300
        im=Image.fromarray(c['rgb']);im.thumbnail((285,240))
        sheet.paste(im,(x,y+55))
        draw.text((x+3,y+3),f"page {p+1} (index {p}), rank {rank}, xref {c['xref']}",fill='black')
        draw.text((x+3,y+17),f"panel={c['inside_panel']} red={c['red_arrow_fraction']:.3f}",fill='black')
        draw.text((x+3,y+31),str([round(v,1) for v in c['bbox']]),fill='black')
        records.append(dict(page=p+1,rank=rank,**{k:v for k,v in c.items() if k not in ('rgb','mask')}))
sheet.save(out/'native-scenes-pages3-6.png')
(out/'native-scenes-pages3-6.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
