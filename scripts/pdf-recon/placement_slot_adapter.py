"""Pose-free, explicitly scoped adapter from inventory slots to legacy rows."""
import argparse,copy,hashlib,json
from pathlib import Path


def adapt(source,pages):
    pages=sorted(set(map(int,pages)))
    if not pages or any(p<0 for p in pages):raise ValueError('Explicit nonnegative page scope required')
    if source.get('pdf_only') is not True or source.get('truth_used') is not False or source.get('runtime_vlm_calls')!=0:raise ValueError('Slot source lacks deterministic PDF-only provenance')
    rows=[];blocked=[]
    for entry in source['evidence']:
        if entry['page'] not in pages:continue
        choices=sorted(set((str(c['part']),str(c['color'])) for c in entry.get('part_choices',[])))
        if len(choices)!=1:blocked.append(dict(page=entry['page'],inventory_slot=entry.get('inventory_slot'),qty=entry['qty'],choices=choices,reason='Ambiguous or unmapped inventory identity'));continue
        row=copy.deepcopy(entry);row['part'],row['color']=choices[0];rows.append(row)
    blocked.extend(dict(entry,reason='Unresolved callout') for entry in source.get('unresolved',[]) if entry['page'] in pages)
    if blocked:raise ValueError('Slot adapter refuses unresolved page scope: '+json.dumps(blocked))
    return dict(pdf=source['pdf'],pdf_sha256=source['pdf_sha256'],pdf_only=True,truth_used=False,runtime_vlm_calls=0,
        allocation_pages=pages,evidence=rows,unresolved=[],assigned_pieces=sum(int(r['qty']) for r in rows),
        inventory_sha256=source.get('inventory_sha256'),checkpoint_sha256=source.get('checkpoint_sha256'),source_sha256=source.get('source_sha256'),
        certified=False,limitations=['Explicit page scope only; legacy reader must enforce allocation_pages.','No poses or arbitrary variant resolution are introduced.','Inventory and encoder hashes are preserved upstream provenance claims unless their actual files are separately verified.'])


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True,type=Path);p.add_argument('--pages',required=True,type=int,nargs='+');p.add_argument('--out',required=True,type=Path);p.add_argument('--inventory',type=Path);p.add_argument('--checkpoint',type=Path);a=p.parse_args()
    payload=a.source.read_bytes();source=json.loads(payload);adapted=adapt(source,a.pages)
    if hashlib.sha256(Path(source['pdf']).read_bytes()).hexdigest()!=source['pdf_sha256']:raise ValueError('Actual PDF hash mismatch')
    verified={}
    for key,path in [('inventory_sha256',a.inventory),('checkpoint_sha256',a.checkpoint)]:
        if path is not None:
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            if digest!=source.get(key):raise ValueError(key+' file mismatch')
            verified[key]=dict(path=str(path.resolve()),sha256=digest)
    adapted.update(slot_source=str(a.source.resolve()),slot_source_sha256=hashlib.sha256(payload).hexdigest(),verified_artifacts=verified)
    # All ambiguity and hash validation happens before producing usable files.
    a.out.mkdir(parents=True,exist_ok=False);(a.out/'slot-source.json').write_bytes(payload)
    (a.out/'global-assignment.json').write_text(json.dumps(adapted,indent=2))
    manifest={k:adapted[k] for k in ('pdf','pdf_sha256','pdf_only','truth_used','runtime_vlm_calls','allocation_pages','inventory_sha256','checkpoint_sha256','slot_source','slot_source_sha256','verified_artifacts')}
    manifest['adapter_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest();(a.out/'manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps(dict(pages=a.pages,pieces=adapted['assigned_pieces'],out=str(a.out))))
