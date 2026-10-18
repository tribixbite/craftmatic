"""Explicit arrow-hue component graph for PDF-native scenes.

Arrow hue must be known to be absent from actual parts in the current scene.
PCA arrow direction is a hypothesis; head/shaft ambiguity is reported.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
import pymupdf
from PIL import Image, ImageDraw
from vector_scene import scene_images,scene_fragments


def component_graph(scene, arrow_color='red'):
    parts=scene_fragments(scene,arrow_color)
    rgb=scene['rgb'];r,g,b=rgb.transpose(2,0,1).astype(np.int16)
    color=((r>120)&(r>g+45)&(r>b+45)) if arrow_color=='red' else ((g>95)&(g>r+25)&(g>b+20))
    n,labels,stats,_=cv2.connectedComponentsWithStats(color.astype(np.uint8),8)
    arrows=[]
    for i in range(1,n):
        if stats[i,cv2.CC_STAT_AREA]<8:continue
        yy,xx=np.nonzero(labels==i);points=np.stack((xx,yy),axis=1).astype(float)
        center=points.mean(0);_,singular,vh=np.linalg.svd(points-center,full_matrices=False)
        axis=vh[0];normal=np.array([-axis[1],axis[0]])
        along=(points-center)@axis;across=(points-center)@normal
        lo,hi=along.min(),along.max();length=hi-lo
        if length<5:continue
        spans=[]
        for end in (along<lo+length*.3,along>hi-length*.3):
            spans.append(float(np.ptp(across[end])) if end.any() else 0.)
        high_head=spans[1]>spans[0]
        head=center+axis*(hi if high_head else lo)
        tail=center+axis*(lo if high_head else hi)
        def nearby(point):
            values=[]
            for j,part in enumerate(parts):
                py,px=np.nonzero(part['mask'])
                distance=float(np.sqrt(((px-point[0])**2+(py-point[1])**2).min()))
                values.append(dict(component=j,distance=distance))
            return sorted(values,key=lambda v:v['distance'])[:2]
        arrows.append(dict(head=head.tolist(),tail=tail.tolist(),direction=(head-tail).tolist(),
            width_ratio=max(spans)/max(1.,min(spans)),direction_ambiguous=abs(spans[0]-spans[1])<2,
            head_candidates=nearby(head),tail_candidates=nearby(tail)))
    return dict(components=parts,arrows=arrows,
                stable_component_candidate=0 if parts else None,
                complete_scene_verified=False)


def diagnostic(pdf,out):
    doc=pymupdf.open(pdf);out.mkdir(parents=True,exist_ok=True)
    sheet=Image.new('RGB',(1500,1200),'#eeeeee');draw=ImageDraw.Draw(sheet);records=[]
    palette=['magenta','orange','cyan','lime']
    for row,p in enumerate(range(2,6)):
        for col,scene in enumerate(scene_images(doc,doc[p])[:4]):
            graph=component_graph(scene)
            x=col*375;y=row*300;im=Image.fromarray(scene['rgb'])
            scale=min(350/im.width,240/im.height);im=im.resize((round(im.width*scale),round(im.height*scale)))
            sheet.paste(im,(x,y+40));draw.text((x+2,y+2),f'page {p+1} rank {col}: {len(graph["components"])} components',fill='black')
            for j,part in enumerate(graph['components']):
                x0,y0,x1,y1=part['bbox'];box=(x+x0*scale,y+40+y0*scale,x+x1*scale,y+40+y1*scale)
                draw.rectangle(box,outline=palette[j%4],width=2);draw.text(box[:2],str(j),fill=palette[j%4])
                Image.fromarray((part['mask']*255).astype('uint8')).save(out/f'p{p+1}-scene{col}-component{j}.png')
            clean={k:v for k,v in graph.items() if k!='components'}
            clean['components']=[{k:v for k,v in c.items() if k!='mask'} for c in graph['components']]
            records.append(dict(page=p+1,scene_rank=col,xref=scene['xref'],**clean))
    sheet.save(out/'component-graph.png')
    (out/'component-graph.json').write_text(json.dumps(records,indent=2),encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('pdf');parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();diagnostic(args.pdf,args.out)
