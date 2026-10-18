"""Frozen research CNN with references derived only from this input PDF."""
from pathlib import Path
import os
import numpy as np
import pymupdf
import torch
from torch import nn
import torch.nn.functional as F
from matching_trials import canonical, BASE, OUT


class Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.net=nn.Sequential(nn.Conv2d(3,24,5,2,2),nn.ReLU(),nn.Conv2d(24,48,3,2,1),nn.ReLU(),
            nn.Conv2d(48,64,3,2,1),nn.ReLU(),nn.Flatten(),nn.Linear(64*8*8,96))
    def forward(self,x): return F.normalize(self.net(x),dim=1)


class FrozenPdfMatcher:
    def __init__(self,doc):
        self.placement_stats={'calls':0,'scored_calls':0,'candidate_windows':0}
        from recon_extract import pdf_inventory as bom
        from recon_extract.pdf_icon_matcher import icon_box
        torch.set_num_threads(4)
        torch.use_deterministic_algorithms(True)
        self.model=Encoder().eval()
        self.checkpoint_path=Path(os.environ.get('PDF_MATCHER_CHECKPOINT',str(OUT/'artwork-encoder.pt')))
        self.model.load_state_dict(torch.load(self.checkpoint_path,weights_only=True,map_location='cpu'))
        cat=bom.bridge_catalog(bom.load_studio_catalog(BASE/'extracted/studio_earlyaccess/app/data'),bom.load_catalog(BASE/'elements.csv'))
        inv=bom.extract(doc,cat,namespace='ldraw')
        self.refs=[]
        images=[]
        for r in inv['records']:
            if 'part' not in r: continue
            box=icon_box(doc[r['page']],r,inv['records'])
            if not box: continue
            pix=doc[r['page']].get_pixmap(matrix=pymupdf.Matrix(4,4),clip=pymupdf.Rect(box),alpha=False)
            im=canonical(np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3])
            if im is None: continue
            self.refs.append((r['part'],r['color']))
            images.append(im)
        if not images: raise ValueError('No PDF artwork references; no set-specific fallback permitted')
        with torch.no_grad(): self.emb=self.model(torch.tensor(np.stack(images).transpose(0,3,1,2),dtype=torch.float32)/255).numpy()

    def match(self,crop,bg=None,qty=1,remaining=None):
        image=canonical(crop)
        if image is None: return None
        with torch.no_grad(): query=self.model(torch.tensor(image.transpose(2,0,1)[None],dtype=torch.float32)/255).numpy()[0]
        eligible=[i for i,key in enumerate(self.refs) if remaining is None or remaining.get(key,0)>0]
        if not eligible: return None
        scores=self.emb[eligible]@query
        k=int(np.argmax(scores))
        part,color=self.refs[eligible[k]]
        return {'part':part,'color':color,'score':float(scores[k]),'certified':False}

    def locate(self,ctx,asm,part,color,transforms,**kwargs):
        """Compare projected candidate image windows to the PDF's part icon.

        Experimental image evidence only: depends on current camera fit and
        cannot resolve candidates with identical projection or occluded parts.
        """
        from recon_v8.deltarender import ldu_to_px
        self.placement_stats['calls']+=1
        from recon_v8.pagerank import _world_aabb
        from recon_v8.pointing import candidate_px
        refs=[i for i,key in enumerate(self.refs) if key==(str(part).removesuffix('.dat'),str(color))]
        if not refs: return None
        M,O=ldu_to_px(ctx)
        images,indices=[],[]
        for i,T in enumerate(transforms):
            ab=_world_aabb(part,T)
            if ab is None: continue
            corners=np.array([[x,y,z] for x in (ab[0][0],ab[1][0]) for y in (ab[0][1],ab[1][1]) for z in (ab[0][2],ab[1][2])])
            px=corners@M.T+O
            lo,hi=px.min(0)-2,px.max(0)+2
            x0,y0=np.floor(lo).astype(int)
            x1,y1=np.ceil(hi).astype(int)
            if x0<0 or y0<0 or x1>ctx.W or y1>ctx.H or min(x1-x0,y1-y0)<5: continue
            im=canonical(ctx.rgb[y0:y1,x0:x1])
            if im is None: continue
            images.append(im)
            indices.append(i)
        if not images: return None
        self.placement_stats['scored_calls']+=1
        self.placement_stats['candidate_windows']+=len(images)
        with torch.no_grad(): emb=self.model(torch.tensor(np.stack(images).transpose(0,3,1,2),dtype=torch.float32)/255).numpy()
        scores=(emb@self.emb[refs].T).max(1)
        winner=indices[int(np.argmax(scores))]
        return {'points':[candidate_px(ctx,part,transforms)[winner].tolist()],
                'method':'frozen-cnn-candidate-window','score':float(scores.max()),'certified':False}
