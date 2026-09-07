"""Frozen encoder transfer to real step PLI; historical labels are diagnostic."""
import json
from collections import Counter
from pathlib import Path
import sys
import numpy as np
import cv2
import pymupdf
import torch
from torch import nn
import torch.nn.functional as F
from matching_trials import OUT, BASE, canonical, features
sys.path.insert(0, str(BASE))


def main():
    from recon_extract import pdf_inventory as bom
    from recon_extract.pdf_icon_matcher import icon_box
    from recon_extract.label_schema import label_error
    from recon_v7 import pdfpick
    torch.set_num_threads(4)
    torch.use_deterministic_algorithms(True)
    class Encoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.net=nn.Sequential(nn.Conv2d(3,24,5,2,2),nn.ReLU(),nn.Conv2d(24,48,3,2,1),nn.ReLU(),
                nn.Conv2d(48,64,3,2,1),nn.ReLU(),nn.Flatten(),nn.Linear(64*8*8,96))
        def forward(self,x): return F.normalize(self.net(x),dim=1)
    model=Encoder().eval()
    model.load_state_dict(torch.load(OUT/'artwork-encoder.pt',weights_only=True,map_location='cpu'))
    def embed(images, mode):
        if mode!='learned': return features(images,mode)
        with torch.no_grad(): return model(torch.tensor(images.transpose(0,3,1,2),dtype=torch.float32)/255).numpy()
    catalog=bom.bridge_catalog(bom.load_studio_catalog(BASE/'extracted/studio_earlyaccess/app/data'),bom.load_catalog(BASE/'elements.csv'))
    bench=BASE/'recon_extract/fixtures/pli_bench'
    raw=json.loads((bench/'labels.json').read_text())
    labels=[r for r in raw if not label_error(r)]
    trainsets={r['set'] for r in json.loads((OUT/'artwork.json').read_text())['records'] if r['split']=='train'}
    pdfpick.CACHE=OUT/'transfer-pdfpick.json'
    results=[]
    sheet=[]
    for sn in sorted({r['set'] for r in labels}):
        pdf,_=pdfpick.pick(sn)
        refs,images=[],[]
        with pymupdf.open(pdf) as doc:
            inv=bom.extract(doc,catalog,namespace='ldraw')
            for r in inv['records']:
                if 'part' not in r: continue
                box=icon_box(doc[r['page']],r,inv['records'])
                if not box: continue
                pix=doc[r['page']].get_pixmap(matrix=pymupdf.Matrix(4,4),clip=pymupdf.Rect(box),alpha=False)
                im=canonical(np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3])
                if im is None: continue
                refs.append((r['part'],r['color']))
                images.append(im)
        if not images: continue
        images=np.stack(images)
        refemb={m:embed(images,m) for m in ['pixels','hog','learned']}
        for r in [r for r in labels if r['set']==sn]:
            rawim=cv2.cvtColor(cv2.imread(str(bench/'crops'/r['file'])),cv2.COLOR_BGR2RGB)
            q=canonical(rawim)
            if q is None: continue
            truth=(r['part'].removesuffix('.dat'),str(r['color']))
            row={'set':sn,'file':r['file'],'truth':truth,'available':truth in refs,'set_seen_in_training':sn in trainsets,'predictions':{}}
            for m in refemb:
                qe=embed(q[None],m)[0]
                index=int(np.argmax(refemb[m]@qe))
                row['predictions'][m]={'part_color':refs[index],'exact':refs[index]==truth}
                if m=='learned' and len(sheet)<32:
                    tile=np.full((100,220,3),255,np.uint8)
                    tile[:64,:64]=q
                    tile[:64,72:136]=images[index]
                    if truth in refs: tile[:64,148:212]=images[refs.index(truth)]
                    cv2.putText(tile,f'{sn} query / CNN / label',(2,78),cv2.FONT_HERSHEY_SIMPLEX,.34,(0,0,0),1)
                    cv2.putText(tile,f'{truth[0]} c{truth[1]}',(2,94),cv2.FONT_HERSHEY_SIMPLEX,.34,(0,0,0),1)
                    sheet.append(tile)
            results.append(row)
    summary={}
    for scope,rows in [('all',results),('unseen_sets',[r for r in results if not r['set_seen_in_training']])]:
        summary[scope]={'queries':len(rows),'available':sum(r['available'] for r in rows),
                       'correct':{m:sum(r['predictions'][m]['exact'] for r in rows) for m in ['pixels','hog','learned']}}
    report={'summary':summary,'rows':results,'invalid_labels_excluded':len(raw)-len(labels),
            'runtime_vlm_calls':0,'no_color_oracle':True,
            'limitations':'Historical automatic labels need independent relabeling; this is transfer diagnosis only'}
    (OUT/'step-transfer-results.json').write_text(json.dumps(report,indent=2))
    if sheet:
        canvas=np.full((((len(sheet)+3)//4)*100,880,3),255,np.uint8)
        for i,t in enumerate(sheet): canvas[(i//4)*100:(i//4+1)*100,(i%4)*220:(i%4+1)*220]=t
        cv2.imwrite(str(OUT/'transfer-contact-sheet.png'),cv2.cvtColor(canvas,cv2.COLOR_RGB2BGR))
    print(json.dumps(summary,indent=2))


if __name__=='__main__': main()
