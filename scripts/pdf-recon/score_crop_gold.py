"""Score frozen matchers on visually checked development callouts."""
import json
import os
from pathlib import Path
import sys
import cv2
import numpy as np
import pymupdf
import torch
from torch import nn
import torch.nn.functional as F
from matching_trials import canonical, features, BASE
from pdf_crop_trial import OUT,artwork_pixels
sys.path.insert(0,str(BASE))


def main():
    from recon_extract import extract_e4 as e4
    from recon_extract import pdf_inventory as bom
    from recon_extract.pdf_icon_matcher import icon_box
    gold=json.loads(Path(__file__).with_name('crop_gold.json').read_text())
    trials=json.loads((OUT/'results.json').read_text())
    train=json.loads((OUT.parent/'pdf-recon-trials/artwork.json').read_text())
    assert gold['set'] not in {r['set'] for r in train['records'] if r['split']=='train'}
    torch.set_num_threads(4)
    class Encoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.net=nn.Sequential(nn.Conv2d(3,24,5,2,2),nn.ReLU(),nn.Conv2d(24,48,3,2,1),nn.ReLU(),nn.Conv2d(48,64,3,2,1),nn.ReLU(),nn.Flatten(),nn.Linear(64*8*8,96))
        def forward(self,x): return F.normalize(self.net(x),dim=1)
    model=Encoder().eval()
    checkpoint=Path(os.environ.get('PDF_MATCHER_CHECKPOINT',str(OUT.parent/'pdf-recon-trials/artwork-encoder.pt')))
    model.load_state_dict(torch.load(checkpoint,weights_only=True,map_location='cpu'))
    def embed(images,mode):
        if mode!='cnn': return features(images,mode)
        with torch.no_grad(): return model(torch.tensor(images.transpose(0,3,1,2),dtype=torch.float32)/255).numpy()
    refs,images,queries=[],[],[]
    with pymupdf.open(BASE/'lego_sets/PDF'/gold['pdf']) as doc:
        catalog=bom.bridge_catalog(bom.load_studio_catalog(BASE/'extracted/studio_earlyaccess/app/data'),bom.load_catalog(BASE/'elements.csv'))
        inv=bom.extract(doc,catalog,namespace='ldraw')
        (OUT/'41637-bom.json').write_text(json.dumps(inv,indent=2))
        for r in inv['records']:
            if 'part' not in r: continue
            box=icon_box(doc[r['page']],r,inv['records'])
            if not box: continue
            pix=doc[r['page']].get_pixmap(matrix=pymupdf.Matrix(4,4),clip=pymupdf.Rect(box),alpha=False)
            im=canonical(np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3])
            if im is not None:
                images.append(im)
                refs.append((r['part'],r['color']))
        for r in gold['records']:
            row=next(x for x in trials['rows'] if x['set']==gold['set'] and x['page']==r['page'])
            item=row['new'][r['anchor_index']]
            x0,y0,x1,y1=item['bbox']
            clean=artwork_pixels(e4.render_page(doc,r['page']),doc[r['page']].get_text('words'),e4.ERA4.pli_bg)
            queries.append(canonical(clean[y0:y1,x0:x1]))
    images,queries=np.stack(images),np.stack(queries)
    results={}
    for mode in ['pixels','hog','cnn']:
        sim=embed(queries,mode)@embed(images,mode).T
        rows=[]
        for r,pred in zip(gold['records'],sim.argmax(1)):
            rows.append(dict(r,prediction=refs[pred],exact=refs[pred]==(r['part'],r['color'])))
        results[mode]={'correct':sum(r['exact'] for r in rows),'total':len(rows),'rows':rows}
    report={'set_unseen_during_training':True,'no_color_oracle':True,'runtime_vlm_calls':0,
            'protocol':gold['protocol'],'results':results}
    import hashlib
    report['inputs_sha256']={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
        [BASE/'lego_sets/PDF'/gold['pdf'],Path(__file__).with_name('crop_gold.json'),OUT/'results.json',checkpoint]}
    name='gold-scores.json' if checkpoint.name=='artwork-encoder.pt' else f'gold-scores-{checkpoint.stem}.json'
    (OUT/name).write_text(json.dumps(report,indent=2))
    print(json.dumps({m:{k:v for k,v in r.items() if k!='rows'} for m,r in results.items()},indent=2))


if __name__=='__main__': main()
