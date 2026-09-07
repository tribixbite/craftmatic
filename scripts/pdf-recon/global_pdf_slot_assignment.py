"""Assign PDF callouts to inventory slots without dropping ambiguous mold IDs.

A slot has one capacity even if its element maps to multiple CAD variants.
Ambiguous identities remain explicit; no arbitrary variant is emitted as fact.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import lil_matrix


def solve_slots(items,slots,scores,floor=.30):
    variables=[(i,j,float(scores[i,j])) for i,item in enumerate(items) for j,slot in enumerate(slots)
               if slot['qty']>=item['qty'] and scores[i,j]>=floor]
    if not variables:raise ValueError('No candidate inventory slots')
    matrix=lil_matrix((len(items)+len(slots),len(variables)),dtype=float)
    for k,(i,j,score) in enumerate(variables):
        matrix[i,k]=1;matrix[len(items)+j,k]=items[i]['qty']
    upper=np.array([1]*len(items)+[s['qty'] for s in slots],float)
    result=milp(-np.array([items[i]['qty']*s for i,j,s in variables]),
        integrality=np.ones(len(variables)),bounds=Bounds(0,1),
        constraints=LinearConstraint(matrix.tocsc(),np.zeros(len(upper)),upper),
        options={'time_limit':30,'mip_rel_gap':.0001})
    if result.x is None:raise RuntimeError(result.message)
    selected=[(i,j,s) for value,(i,j,s) in zip(result.x,variables) if value>.5]
    return selected,dict(status=int(result.status),message=result.message,
        gap=float(result.mip_gap) if getattr(result,'mip_gap',None) is not None else None)


def run(pdf,allocation_run,out):
    if out.exists():raise ValueError('Choose a new output directory')
    from placement_pdf_group_evidence import load_allocations
    _,bound=load_allocations(pdf,0,allocation_run)
    import pymupdf,torch
    from frozen_pdf_matcher import Encoder,OUT
    from matching_trials import canonical
    from pdf_crop_trial import crop_items,artwork_pixels
    from recon_extract import extract_e4 as e4
    from recon_extract.pdf_inventory import is_inventory_page
    from recon_extract.pdf_icon_matcher import icon_box
    out.mkdir(parents=True)
    checkpoint=OUT/'artwork-encoder.pt'
    model=Encoder().eval();model.load_state_dict(torch.load(checkpoint,weights_only=True,map_location='cpu'))
    torch.set_num_threads(4);torch.use_deterministic_algorithms(True)
    inventory_path=allocation_run/'inventory.json';inventory=json.loads(inventory_path.read_text())
    slots=[];references=[];items=[];images=[];rejected=[]
    with pymupdf.open(pdf) as doc:
        for index,record in enumerate(inventory['records']):
            choices=[(str(record['part']),str(record['color']))] if 'part' in record else record.get('candidates',[])
            if not choices:continue
            box=icon_box(doc[record['page']],record,inventory['records'])
            if box is None:continue
            pix=doc[record['page']].get_pixmap(matrix=pymupdf.Matrix(4,4),clip=pymupdf.Rect(box),alpha=False)
            rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3]
            image=canonical(rgb)
            if image is None:continue
            slots.append(dict(inventory_record=index,element_id=record.get('element_id'),qty=record['qty'],
                choices=[dict(part=p,color=c) for p,c in choices],source_page=record['page'],icon_bbox=box))
            references.append(image)
        for page in range(len(doc)):
            if is_inventory_page(doc[page]):continue
            rgb=e4.render_page(doc,page);words=doc[page].get_text('words')
            tokens=e4.page_tokens(doc,page,style=e4.ERA4)
            crops=crop_items(rgb,words,tokens['qty_small'],e4.ERA4.pli_bg)
            clean=artwork_pixels(rgb,words,e4.ERA4.pli_bg)
            for crop in crops:
                if 'bbox' not in crop:rejected.append(dict(crop,page=page));continue
                x0,y0,x1,y1=crop['bbox'];image=canonical(clean[y0:y1,x0:x1])
                if image is None:rejected.append(dict(crop,page=page));continue
                items.append(dict(crop,page=page));images.append(image)
    def embed(values):
        with torch.no_grad():
            tensor=torch.tensor(np.stack(values).transpose(0,3,1,2),dtype=torch.float32)/255
            return torch.cat([model(tensor[i:i+64]) for i in range(0,len(values),64)]).numpy()
    scores=embed(images)@embed(references).T
    selected,solver=solve_slots(items,slots,scores)
    evidence=[];assigned=set()
    for i,j,score in selected:
        assigned.add(i);slot=slots[j];choices=slot['choices']
        row=dict(items[i],inventory_slot=j,element_id=slot['element_id'],score=score,part_choices=choices)
        if len(choices)==1:row.update(choices[0])
        else:row['identity_status']='ambiguous_universal_mold_mapping'
        evidence.append(row)
    unresolved=rejected+[dict(item,reason='No inventory slot assigned') for i,item in enumerate(items) if i not in assigned]
    report=dict(pdf=str(pdf.resolve()),pdf_sha256=bound['pdf_sha256'],pdf_only=True,runtime_vlm_calls=0,
        truth_used=False,certified=False,slots=slots,evidence=evidence,unresolved=unresolved,
        assigned_callouts=len(assigned),assigned_pieces=sum(r['qty'] for r in evidence),
        unambiguous_identity_pieces=sum(r['qty'] for r in evidence if 'part' in r),
        ambiguous_identity_pieces=sum(r['qty'] for r in evidence if 'part' not in r),solver=solver,
        inventory_sha256=hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
        checkpoint_sha256=hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        limitations=['Inventory allocation is not identity or placement certification',
                    'Ambiguous variants require geometric evidence or an available parts list',
                    'Runtime remains a frozen deterministic encoder; no training or VLM calls',
                    'Experimental Era4 slot assignment; not wired into legacy pose input'])
    (out/'slot-assignment.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({k:report[k] for k in ('assigned_callouts','assigned_pieces','unambiguous_identity_pieces','ambiguous_identity_pieces')}))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('pdf',type=Path);p.add_argument('--allocation-run',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.pdf,a.allocation_run,a.out)
