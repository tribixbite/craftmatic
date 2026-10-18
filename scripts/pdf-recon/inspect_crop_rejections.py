"""Render deterministic samples of rejected quantity anchors for visual diagnosis."""
import json
from pathlib import Path
import cv2
import numpy as np
import pymupdf
from pdf_crop_trial import OUT


def main():
    result=json.loads((OUT/'results.json').read_text())
    rejected=[dict(set=r['set'],page=r['page'],pdf=r['pdf'],**i)
              for r in result['rows'] for i in r['new'] if 'bbox' not in i]
    chosen=[rejected[i] for i in np.linspace(0,len(rejected)-1,min(36,len(rejected)),dtype=int)]
    tiles=[]
    for index,r in enumerate(chosen):
        x0,y0,x1,y1=np.asarray(r['anchor'])/1.6
        with pymupdf.open(r['pdf']) as doc:
            rect=pymupdf.Rect(max(0,x0-25),max(0,y0-90),min(doc[r['page']].rect.width,x0+110),min(doc[r['page']].rect.height,y1+20))
            pix=doc[r['page']].get_pixmap(matrix=pymupdf.Matrix(2,2),clip=rect,alpha=False)
            rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3].copy()
            a=(int((x0-rect.x0)*2),int((y0-rect.y0)*2))
            b=(int((x1-rect.x0)*2),int((y1-rect.y0)*2))
            cv2.rectangle(rgb,a,b,(255,0,0),1)
        tile=np.full((255,280,3),255,np.uint8)
        scale=min(275/rgb.shape[1],220/rgb.shape[0])
        rgb=cv2.resize(rgb,(int(rgb.shape[1]*scale),int(rgb.shape[0]*scale)))
        tile[:rgb.shape[0],:rgb.shape[1]]=rgb
        cv2.putText(tile,f'{index} {r["set"]} p{r["page"]} qty{r["qty"]}',(3,235),cv2.FONT_HERSHEY_SIMPLEX,.43,(0,0,0),1)
        cv2.putText(tile,r['unresolved'][:38],(3,250),cv2.FONT_HERSHEY_SIMPLEX,.32,(0,0,0),1)
        tiles.append(tile)
    (OUT/'rejected-samples.json').write_text(json.dumps(chosen,indent=2))
    for start in range(0,len(tiles),12):
        batch=tiles[start:start+12]
        canvas=np.full((((len(batch)+2)//3)*255,840,3),255,np.uint8)
        for i,t in enumerate(batch):canvas[(i//3)*255:(i//3+1)*255,(i%3)*280:(i%3+1)*280]=t
        cv2.imwrite(str(OUT/f'rejected-{start//12}.png'),cv2.cvtColor(canvas,cv2.COLOR_RGB2BGR))


if __name__=='__main__':main()
