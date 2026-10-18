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


def bind_pdf(pdf,allocation_run):
    """Verify the PDF against whatever provenance the input directory carries.

    Historically this stage read a completed ALLOCATION merely to recover a
    verified PDF hash, which made the on-ramp circular: an allocation is
    downstream of this assignment. A directory holding only the printed
    inventory (`placement_pdf_inventory`) carries the same claim, and a bare
    inventory carries none - in which case the PDF is hashed here and the
    provenance says so, rather than a hash being taken on trust.
    """
    if (allocation_run/'manifest.json').is_file() and (allocation_run/'global-assignment.json').is_file():
        from placement_pdf_group_evidence import load_allocations
        return load_allocations(pdf,0,allocation_run)[1],'allocation manifest'
    digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
    manifest=allocation_run/'inventory-manifest.json'
    if manifest.is_file():
        claimed=json.loads(manifest.read_text())
        if claimed.get('pdf_sha256')!=digest:raise ValueError('Inventory manifest PDF hash mismatch')
        if claimed.get('truth_used') is not False or claimed.get('runtime_vlm_calls')!=0:
            raise ValueError('Inventory provenance is not truth-free and VLM-free')
        return dict(pdf_sha256=digest),'inventory manifest'
    return dict(pdf_sha256=digest),'hashed here; the inventory directory carries no manifest'


def run(pdf,allocation_run,out,color_constraints=False,panel_geometry=False,inventory_components=False):
    if out.exists():raise ValueError('Choose a new output directory')
    bound,provenance=bind_pdf(pdf,allocation_run)
    import pymupdf,torch
    from frozen_pdf_matcher import Encoder,OUT
    from matching_trials import canonical
    from pdf_crop_trial import crop_items,artwork_pixels,pdf_pli_panel_bounds
    from recon_extract import extract_e4 as e4
    from recon_extract.pdf_inventory import is_inventory_page
    from recon_extract.pdf_icon_matcher import icon_box
    out.mkdir(parents=True)
    checkpoint=OUT/'artwork-encoder.pt'
    model=Encoder().eval();model.load_state_dict(torch.load(checkpoint,weights_only=True,map_location='cpu'))
    torch.set_num_threads(4);torch.use_deterministic_algorithms(True)
    inventory_path=allocation_run/'inventory.json';inventory=json.loads(inventory_path.read_text())
    slots=[];references=[];items=[];images=[];rejected=[];unusable_inventory=[]
    native_references=[];native_images=[]
    inventory_refinements=[]
    with pymupdf.open(pdf) as doc:
        for index,record in enumerate(inventory['records']):
            choices=[(str(record['part']),str(record['color']))] if 'part' in record else record.get('candidates',[])
            box=icon_box(doc[record['page']],record,inventory['records'])
            if box is None:
                unusable_inventory.append(dict(inventory_record=index,qty=record['qty'],reason='Inventory icon box unavailable'));continue
            pix=doc[record['page']].get_pixmap(matrix=pymupdf.Matrix(4,4),clip=pymupdf.Rect(box),alpha=False)
            rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3]
            if inventory_components:
                from placement_inventory_component import refine
                q=record['qty_bbox'];anchor=[q[0]*4-pix.x,q[1]*4-pix.y,(q[3]-q[1])*4]
                rgb,refinement=refine(rgb,anchor)
                inventory_refinements.append(dict(inventory_record=index,**refinement))
            image=canonical(rgb)
            if image is None:
                unusable_inventory.append(dict(inventory_record=index,qty=record['qty'],reason='Inventory icon foreground unavailable'));continue
            slots.append(dict(inventory_record=index,element_id=record.get('element_id'),qty=record['qty'],
                choices=[dict(part=p,color=c) for p,c in choices],source_page=record['page'],icon_bbox=box))
            references.append(image)
            native_references.append(rgb)
        for page in range(len(doc)):
            if is_inventory_page(doc[page]):continue
            rgb=e4.render_page(doc,page);words=doc[page].get_text('words')
            tokens=e4.page_tokens(doc,page,style=e4.ERA4)
            panels=pdf_pli_panel_bounds(doc[page],e4.ERA4.pli_bg) if panel_geometry else ()
            crops=crop_items(rgb,words,tokens['qty_small'],e4.ERA4.pli_bg,panel_bounds=panels)
            clean=artwork_pixels(rgb,words,e4.ERA4.pli_bg)
            for crop in crops:
                if 'bbox' not in crop:rejected.append(dict(crop,page=page));continue
                x0,y0,x1,y1=crop['bbox'];image=canonical(clean[y0:y1,x0:x1])
                if image is None:rejected.append(dict(crop,page=page));continue
                items.append(dict(crop,page=page));images.append(image);native_images.append(clean[y0:y1,x0:x1].copy())
    def embed(values):
        with torch.no_grad():
            tensor=torch.tensor(np.stack(values).transpose(0,3,1,2),dtype=torch.float32)/255
            return torch.cat([model(tensor[i:i+64]) for i in range(0,len(values),64)]).numpy()
    scores=embed(images)@embed(references).T
    np.save(out/'raw-scores.npy',scores)
    color_evidence=None
    if color_constraints:
        from placement_pdf_color_constraints import constrain_scores
        scores,color_evidence=constrain_scores(native_images,native_references,scores)
        (out/'color-constraints.json').write_text(json.dumps(color_evidence,indent=2),encoding='utf-8')
    # Preserve exact runtime comparison inputs for independent image audits.
    # Unmapped elements still own their printed capacity and icon; absence of
    # a CAD identifier must not cause other callouts to consume that capacity.
    np.save(out/'callout-images.npy',np.stack(images));np.save(out/'inventory-images.npy',np.stack(references))
    np.save(out/'scores.npy',scores)
    np.savez_compressed(out/'native-callouts.npz',**{f'image_{i:04d}':im for i,im in enumerate(native_images)})
    np.savez_compressed(out/'native-inventory.npz',**{f'image_{i:04d}':im for i,im in enumerate(native_references)})
    (out/'callouts.json').write_text(json.dumps(items,indent=2),encoding='utf-8')
    selected,solver=solve_slots(items,slots,scores)
    evidence=[];assigned=set()
    for i,j,score in selected:
        assigned.add(i);slot=slots[j];choices=slot['choices']
        row=dict(items[i],inventory_slot=j,element_id=slot['element_id'],score=score,part_choices=choices)
        if len(choices)==1:row.update(choices[0])
        else:row['identity_status']='ambiguous_universal_mold_mapping' if choices else 'unmapped_universal_element'
        evidence.append(row)
    unresolved=rejected+[dict(item,reason='No inventory slot assigned') for i,item in enumerate(items) if i not in assigned]
    report=dict(pdf=str(pdf.resolve()),pdf_sha256=bound['pdf_sha256'],pdf_only=True,runtime_vlm_calls=0,
        truth_used=False,certified=False,slots=slots,evidence=evidence,unresolved=unresolved,
        assigned_callouts=len(assigned),assigned_pieces=sum(r['qty'] for r in evidence),
        unambiguous_identity_pieces=sum(r['qty'] for r in evidence if 'part' in r),
        ambiguous_identity_pieces=sum(r['qty'] for r in evidence if len(r['part_choices'])>1),
        unmapped_identity_pieces=sum(r['qty'] for r in evidence if not r['part_choices']),
        printed_inventory_pieces=sum(r['qty'] for r in inventory['records']),
        usable_slot_capacity=sum(s['qty'] for s in slots),unusable_inventory=unusable_inventory,solver=solver,
        color_constraints=color_constraints,color_contradictions_rejected=len(color_evidence['rejected']) if color_evidence else 0,
        panel_geometry=panel_geometry,pdf_binding=provenance,
        inventory_components=inventory_components,inventory_refinements=inventory_refinements,
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
    p.add_argument('--color-constraints',action='store_true')
    p.add_argument('--panel-geometry',action='store_true')
    p.add_argument('--inventory-components',action='store_true')
    a=p.parse_args();run(a.pdf,a.allocation_run,a.out,a.color_constraints,a.panel_geometry,a.inventory_components)
