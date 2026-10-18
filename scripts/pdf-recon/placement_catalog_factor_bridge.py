"""Conservative factorized namespace evidence from universal element catalogs.

Part and color mappings are learned separately from shared, unambiguous element
records. Only previously unmapped elements are proposed; conflicts are retained.
No set model or placement input is read.
"""
import argparse
from collections import defaultdict
import hashlib,json,sys
from pathlib import Path


def propose(studio,rebrickable,element_ids):
    parts=defaultdict(lambda:defaultdict(list));colors=defaultdict(lambda:defaultdict(list))
    for eid in sorted(studio.keys()&rebrickable.keys()):
        if len(studio[eid])!=1 or len(rebrickable[eid])!=1:continue
        rp,rc=next(iter(rebrickable[eid]));lp,lc=next(iter(studio[eid]))
        parts[rp][lp].append(eid);colors[rc][lc].append(eid)
    records=[]
    for eid in element_ids:
        raw=rebrickable.get(eid,set());row=dict(element_id=eid,choices=[])
        if len(raw)!=1:
            row['reason']='Universal Rebrickable element absent or ambiguous';records.append(row);continue
        rp,rc=next(iter(raw))
        row.update(rebrickable_part=rp,rebrickable_color=rc,
            part_evidence=[dict(ldraw=p,witness_count=len(ids),witness_elements=ids[:5]) for p,ids in sorted(parts[rp].items())],
            color_evidence=[dict(ldraw=c,witness_count=len(ids),witness_elements=ids[:5]) for c,ids in sorted(colors[rc].items())])
        row['choices']=[dict(part=p,color=c) for p in sorted(parts[rp]) for c in sorted(colors[rc])]
        row['status']='unique_factorized_namespace_mapping' if len(row['choices'])==1 else 'ambiguous_or_missing_namespace_mapping'
        records.append(row)
    return records


def run(source,out,data,elements):
    if out.exists():raise ValueError('Choose a new output directory')
    sys.path.insert(0,'C:/git/clego')
    from recon_extract.pdf_inventory import load_studio_catalog,load_catalog
    inventory=json.loads((source/'inventory.json').read_text())
    wanted=[r['element_id'] for r in inventory['records'] if 'part' not in r and not r.get('candidates')]
    proposals=propose(load_studio_catalog(data),load_catalog(elements),wanted)
    by_id={p['element_id']:p for p in proposals};changed=[]
    for record in inventory['records']:
        if record['element_id'] not in by_id:continue
        proposal=by_id[record['element_id']];choices=proposal['choices']
        if not choices:continue
        record['candidates']=[[p['part'],p['color']] for p in choices]
        record['namespace_provenance']='factorized_universal_element_overlap'
        if len(choices)==1:record.update(choices[0],namespace='ldraw')
        changed.append(record['element_id'])
    def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
    proof=dict(truth_used=False,runtime_vlm_calls=0,proposals=proposals,changed_elements=changed,
        source_inventory_sha256=digest(source/'inventory.json'),
        universal_inputs={str(p):digest(p) for p in [elements,data/'elementInfoList.json',data/'StudioPartDefinition2.txt',data/'StudioColorDefinition.txt']},
        protocol='Separate part and color namespace relations from shared singleton universal elements; never use set poses or infer equality from numeric IDs',
        limitations=['Factorization assumes part and color namespaces are independent; all observed mapping conflicts are preserved.',
                    'Catalog identity evidence is not CAD geometry or placement certification.'])
    inventory['resolved_pieces']=sum(r['qty'] for r in inventory['records'] if 'part' in r)
    inventory['unresolved']=[u for u in inventory.get('unresolved',[]) if u['element_id'] not in changed]
    inventory['factorized_mapping_proof']='catalog-factor-proof.json'
    out.mkdir(parents=True)
    for name in ('manifest.json','global-assignment.json'):(out/name).write_bytes((source/name).read_bytes())
    (out/'inventory.json').write_text(json.dumps(inventory,indent=2),encoding='utf-8')
    (out/'catalog-factor-proof.json').write_text(json.dumps(proof,indent=2),encoding='utf-8')
    print(json.dumps(proof))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--data',type=Path,default=Path('C:/git/clego/extracted/studio_earlyaccess/app/data'))
    p.add_argument('--elements',type=Path,default=Path('C:/git/clego/elements.csv'))
    a=p.parse_args();run(a.source,a.out,a.data,a.elements)
