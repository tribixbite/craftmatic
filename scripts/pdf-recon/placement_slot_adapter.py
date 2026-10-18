"""Pose-free, explicitly scoped adapter from inventory slots to legacy rows.

A row whose element resolves to several LDraw names is refused, and that is
right as long as the names are different parts. `placement_mould_equivalence`
measures when they are not: `15573`/`3794a`/`3794b` and `4032a`/`4032b` have
*exactly* equal universal bounding boxes and differ only under the plate, so the
piece, its colour and its count are known and only the filename is not.

Refusing such a row costs far more than the row. On 41601 the two classes hold
four pieces but sit on four pages that carry **thirteen** allocated pieces
between them, and the whole page is refused for the sake of one name. So the
class is admitted under a stated policy:

* `refuse` (default) - unchanged: any ambiguity refuses the page.
* `withhold` - the class row is *declared* rather than allocated. The page's
  other pieces are drivable, the withheld piece is recorded so the driver can
  attribute its ink at the camera gate, and no name is ever guessed.
* `canonical` - the class row is allocated under the class's canonical name and
  flagged as unresolved-within-class, so a reader knows the pose is evidence and
  the filename is a coin flip inside a proven-equivalent class.

Only a class the table proves shares a capacity pool, and whose members agree on
colour, may be admitted; anything else still refuses.
"""
import argparse,copy,hashlib,json
from pathlib import Path

MOULD_POLICIES=('refuse','withhold','canonical')


def class_index(table):
    """Admissible mould classes keyed by their member-name tuple."""
    index={}
    for entry in (table or {}).get('classes',[]):
        if not entry.get('shares_capacity_pool'):continue
        if entry.get('colors_agree') is False:continue
        index[tuple(sorted(entry['members']))]=entry
    return index


def blocked_rows(source,mould_classes=None,mould_policy='refuse'):
    """Every row of the slot source this adapter would refuse, with its page.

    Refusal is a property of a row, so the page scope that the adapter accepts
    is derivable rather than chosen: it is the set of pages that carry evidence
    and carry no refused row. Round nine recorded the page-scope decision as
    the pipeline's one attended step; this is the function that closes it, and
    it deliberately reports what it excludes rather than dropping it silently.
    """
    admissible=class_index(mould_classes) if mould_policy!='refuse' else {}
    blocked=[]
    for entry in source['evidence']:
        choices=sorted(set((str(c['part']),str(c['color'])) for c in entry.get('part_choices',[])))
        if len(choices)==1:continue
        names=tuple(sorted({part for part,_ in choices}));colors=sorted({color for _,color in choices})
        if len(colors)==1 and admissible.get(names) is not None:continue
        blocked.append(dict(page=entry['page'],inventory_slot=entry.get('inventory_slot'),
                            qty=int(entry['qty']),choices=choices,
                            reason='Ambiguous or unmapped inventory identity'))
    blocked.extend(dict(entry,reason='Unresolved callout') for entry in source.get('unresolved',[]))
    return blocked


def admissible_pages(source,mould_classes=None,mould_policy='refuse'):
    """The maximal page scope this adapter accepts, and why each page is out."""
    refused={}
    for row in blocked_rows(source,mould_classes,mould_policy):
        refused.setdefault(int(row['page']),[]).append(row)
    carried={}
    for entry in source['evidence']:
        carried[int(entry['page'])]=carried.get(int(entry['page']),0)+int(entry['qty'])
    pages=sorted(page for page in carried if page not in refused)
    excluded=[dict(page=page,allocated_pieces_lost=carried.get(page,0),
                   reasons=sorted({row['reason'] for row in rows}),rows=rows)
              for page,rows in sorted(refused.items())]
    return pages,excluded


def adapt(source,pages,mould_classes=None,mould_policy='refuse'):
    if mould_policy not in MOULD_POLICIES:raise ValueError('Unknown mould policy: '+str(mould_policy))
    pages=sorted(set(map(int,pages)))
    if not pages or any(p<0 for p in pages):raise ValueError('Explicit nonnegative page scope required')
    if source.get('pdf_only') is not True or source.get('truth_used') is not False or source.get('runtime_vlm_calls')!=0:raise ValueError('Slot source lacks deterministic PDF-only provenance')
    admissible=class_index(mould_classes) if mould_policy!='refuse' else {}
    rows=[];blocked=[];withheld=[]
    for entry in source['evidence']:
        if entry['page'] not in pages:continue
        choices=sorted(set((str(c['part']),str(c['color'])) for c in entry.get('part_choices',[])))
        if len(choices)!=1:
            names=tuple(sorted({part for part,_ in choices}));colors=sorted({color for _,color in choices})
            klass=admissible.get(names) if len(colors)==1 else None
            if klass is None:
                blocked.append(dict(page=entry['page'],inventory_slot=entry.get('inventory_slot'),qty=entry['qty'],choices=choices,reason='Ambiguous or unmapped inventory identity'));continue
            record=dict(page=entry['page'],inventory_slot=entry.get('inventory_slot'),element_id=entry.get('element_id'),qty=int(entry['qty']),members=list(names),color=colors[0],canonical=klass['canonical'],evidence='Universal CAD bounding boxes agree within '+str(klass.get('tolerance_ldu'))+' LDU; the pipeline predicates do not, so the names stay distinct')
            if mould_policy=='withhold':
                withheld.append(dict(record,disposition='declared, not allocated: the piece exists and is counted, and no filename is guessed'));continue
            row=copy.deepcopy(entry);row['part'],row['color']=klass['canonical'],colors[0]
            row['mould_class']=dict(record,disposition='allocated under the canonical member; the filename is unresolved inside a proven-equivalent class')
            rows.append(row);continue
        row=copy.deepcopy(entry);row['part'],row['color']=choices[0];rows.append(row)
    blocked.extend(dict(entry,reason='Unresolved callout') for entry in source.get('unresolved',[]) if entry['page'] in pages)
    if blocked:raise ValueError('Slot adapter refuses unresolved page scope: '+json.dumps(blocked))
    return dict(pdf=source['pdf'],pdf_sha256=source['pdf_sha256'],pdf_only=True,truth_used=False,runtime_vlm_calls=0,
        allocation_pages=pages,evidence=rows,unresolved=[],assigned_pieces=sum(int(r['qty']) for r in rows),
        withheld_classes=withheld,withheld_pieces=sum(int(r['qty']) for r in withheld),mould_policy=mould_policy,
        inventory_sha256=source.get('inventory_sha256'),checkpoint_sha256=source.get('checkpoint_sha256'),source_sha256=source.get('source_sha256'),
        certified=False,limitations=['Explicit page scope only; legacy reader must enforce allocation_pages.','No poses are introduced; a variant name is resolved only inside a proven mould-equivalence class and only under the canonical policy.','A withheld class row is drawn on its page and is not allocated, so the reader must attribute its ink rather than charge it to the placed pieces.','Inventory and encoder hashes are preserved upstream provenance claims unless their actual files are separately verified.'])


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True,type=Path);p.add_argument('--pages',type=int,nargs='+');p.add_argument('--out',required=True,type=Path);p.add_argument('--inventory',type=Path);p.add_argument('--checkpoint',type=Path)
    p.add_argument('--auto-scope',action='store_true',help='Derive the page scope from the slot source instead of taking it from a human: every page that carries evidence and no refused row')
    p.add_argument('--mould-classes',type=Path,help='A placement_mould_equivalence table whose proven classes may be admitted')
    p.add_argument('--mould-policy',choices=MOULD_POLICIES,default='refuse',help='What to do with a row the table proves is one physical piece under several names')
    a=p.parse_args()
    if (a.pages is None)==(not a.auto_scope):raise SystemExit('Give either an explicit --pages scope or --auto-scope')
    table=json.loads(a.mould_classes.read_text()) if a.mould_classes else None
    payload=a.source.read_bytes();source=json.loads(payload)
    scope,excluded=(admissible_pages(source,table,a.mould_policy) if a.auto_scope else (a.pages,None))
    adapted=adapt(source,scope,table,a.mould_policy)
    if a.auto_scope:
        adapted['scope_source']='placement_slot_adapter.admissible_pages'
        adapted['excluded_pages']=excluded
        adapted['excluded_pieces']=sum(row['allocated_pieces_lost'] for row in excluded)
        adapted['limitations'].append('The page scope is derived from the slot source; an excluded page is recorded with the rows that refused it and the pieces that scope loses.')
    adapted['mould_classes_source']=str(a.mould_classes.resolve()) if a.mould_classes else None
    adapted['mould_classes_sha256']=hashlib.sha256(a.mould_classes.read_bytes()).hexdigest() if a.mould_classes else None
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
    manifest={k:adapted[k] for k in ('pdf','pdf_sha256','pdf_only','truth_used','runtime_vlm_calls','allocation_pages','inventory_sha256','checkpoint_sha256','slot_source','slot_source_sha256','verified_artifacts','mould_policy','mould_classes_source','mould_classes_sha256')}
    manifest['adapter_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest();(a.out/'manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps(dict(pages=scope,pieces=adapted['assigned_pieces'],withheld=adapted['withheld_pieces'],policy=adapted['mould_policy'],auto_scope=bool(a.auto_scope),excluded_pages=[row['page'] for row in (excluded or [])],out=str(a.out))))
