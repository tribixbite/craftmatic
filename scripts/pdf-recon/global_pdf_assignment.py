"""Joint callout identity assignment under PDF-derived inventory capacities."""
from collections import defaultdict
import json
import numpy as np
import torch
from scipy.optimize import milp, Bounds, LinearConstraint
from scipy.sparse import lil_matrix
from pdf_crop_trial import crop_items,artwork_pixels
from matching_trials import canonical


def assign(doc,style,rows,matcher,out):
    from recon_extract import extract_e4 as e4
    from recon_extract.pdf_inventory import is_inventory_page
    keys=[(str(r[1]).removesuffix('.dat'),str(r[0])) for r in rows]
    ref_indices={key:[i for i,k in enumerate(matcher.refs) if k==key] for key in keys}
    images,items=[],[]
    rejected=[]
    for pg in range(len(doc)):
        if is_inventory_page(doc[pg]): continue
        rgb=e4.render_page(doc,pg)
        words=doc[pg].get_text('words')
        tokens=e4.page_tokens(doc,pg,style=style)
        crops=crop_items(rgb,words,tokens['qty_small'],style.pli_bg)
        clean=artwork_pixels(rgb,words,style.pli_bg)
        for c in crops:
            if 'bbox' not in c:
                rejected.append(dict(c,page=pg))
                continue
            x0,y0,x1,y1=c['bbox']
            im=canonical(clean[y0:y1,x0:x1])
            if im is None:
                rejected.append(dict(c,page=pg,unresolved='empty cleaned crop'))
                continue
            images.append(im)
            items.append(dict(c,page=pg))
    if not items: raise ValueError('No assignable PDF callouts')
    with torch.no_grad():
        inputs=torch.tensor(np.stack(images).transpose(0,3,1,2),dtype=torch.float32)/255
        emb=torch.cat([matcher.model(inputs[i:i+64]) for i in range(0,len(inputs),64)]).numpy()
    similarities=emb@matcher.emb.T
    variables=[]
    for i,item in enumerate(items):
        for k,key in enumerate(keys):
            if not ref_indices[key] or rows[k][-1]<item['qty']: continue
            score=float(similarities[i,ref_indices[key]].max())
            if score<.30: continue
            variables.append((i,k,score))
    if not variables: raise ValueError('No candidate clears the same matching floor')
    # Binary choices keep a quantity group together. All upper bounds, never
    # forced inventory filling: unused parts/unassigned callouts are allowed.
    mat=lil_matrix((len(items)+len(keys),len(variables)),dtype=float)
    for j,(i,k,score) in enumerate(variables):
        mat[i,j]=1
        mat[len(items)+k,j]=items[i]['qty']
    upper=np.asarray([1]*len(items)+[r[-1] for r in rows],float)
    objective=-np.asarray([items[i]['qty']*score for i,k,score in variables])
    solution=milp(objective,integrality=np.ones(len(variables)),bounds=Bounds(0,1),
                  constraints=LinearConstraint(mat.tocsc(),np.zeros(len(upper)),upper),
                  options={'time_limit':30,'mip_rel_gap':0.0001})
    if solution.x is None: raise RuntimeError(f'Joint assignment failed: {solution.message}')
    allocations=defaultdict(list)
    evidence=[]
    assigned=set()
    for value,(i,k,score) in zip(solution.x,variables):
        if value<.5: continue
        assigned.add(i)
        allocations[items[i]['page']].append({'index':k,'qty':items[i]['qty']})
        evidence.append(dict(items[i],part=keys[k][0],color=keys[k][1],score=score))
    rejected.extend(dict(item,unresolved='unassigned under PDF capacity constraints') for i,item in enumerate(items) if i not in assigned)
    report={'method':'binary joint callout identity assignment','pdf_only':True,'runtime_vlm_calls':0,
            'status':int(solution.status),'message':solution.message,
            'gap':None if getattr(solution,'mip_gap',None) is None else float(solution.mip_gap),
            'callouts':len(items),'assigned':len(assigned),'assigned_pieces':sum(r['qty'] for r in evidence),
            'evidence':evidence,'unresolved':rejected,
            'limitations':['Inventory consistency does not establish correct step identity or placement',
                           'No subassembly/multiplier graph','Approximate crop/catalog inputs']}
    (out/'global-assignment.json').write_text(json.dumps(report,indent=2))
    return allocations,report
