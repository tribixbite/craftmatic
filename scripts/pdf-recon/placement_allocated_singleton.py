"""Canonical local frame for one automatically allocated PDF part; no pose prior."""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
from placement_pdf_group_evidence import extract
from placement_beam import assembly


def run(pdf,page,allocation_run,out):
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.glob('*.py')}
    evidence=extract(pdf,page,allocation_run,out/'evidence')
    if len(evidence['parts'])!=1:raise ValueError('Exactly one automatically allocated part required')
    part,color=evidence['parts'][0];name='group_000.ldr'
    (out/name).write_text(assembly([(part,int(color),np.eye(4))]).to_ldr('0 PDF allocated singleton; identity defines local frame only'))
    report=dict(pdf=str(pdf.resolve()),pdf_sha256=evidence['pdf_sha256'],source_page=page,source_xref=None,
        allocation_file=evidence['allocation_file'],allocation_sha256=evidence['allocation_sha256'],parts=evidence['parts'],
        truth_used=False,runtime_vlm_calls=0,part_ids_derived_from_pdf=True,multiplicity=1,group_anchor_index=0,group_anchor_part=part,
        code_sha256_start=hashes,certified=False,results=[dict(file=name,transforms=[np.eye(4).tolist()])],
        limitations=['Identity transform defines arbitrary local CAD frame, not placement in assembly','Downstream attachment must infer pose from native main scene'])
    (out/'results.json').write_text(json.dumps(report,indent=2));print(out/'results.json')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('pdf',type=Path);p.add_argument('--page',type=int,required=True);p.add_argument('--allocation-run',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.pdf,a.page,a.allocation_run,a.out)
