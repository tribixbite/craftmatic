"""Provenance adapter for fresh slot assignment from older PDF-only caches.

Only inventory and callout identity evidence are copied; placement records
are excluded. The compatibility filename is global-assignment.json, but its
method explicitly remains historical unary matching until fresh assignment.
"""
import argparse
import hashlib
import json
from pathlib import Path
from global_pdf_slot_assignment import run as assign_slots


def run(pdf,source,out):
    if out.exists():raise ValueError('Choose a new output directory')
    manifest=json.loads((source/'manifest.json').read_text());digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert manifest['pdf_only'] and manifest['runtime_vlm_calls']==0
    assert (manifest.get('pdf_sha256') or manifest['inputs_sha256'][manifest['pdf']])==digest
    out.mkdir(parents=True);adapter=out/'identity-input';adapter.mkdir()
    journal=json.loads((source/'journal.json').read_text());evidence=[]
    for row in journal:
        for crop in row.get('parts',{}).get('crop_evidence',[]):evidence.append(dict(crop,page=row['page']))
    derived=dict(pdf=str(pdf),pdf_sha256=digest,pdf_only=True,runtime_vlm_calls=0,truth_used=False,
        source=str(source),source_manifest_sha256=hashlib.sha256((source/'manifest.json').read_bytes()).hexdigest(),
        source_journal_sha256=hashlib.sha256((source/'journal.json').read_bytes()).hexdigest(),pose_records_copied=False)
    (adapter/'manifest.json').write_text(json.dumps(derived,indent=2))
    (adapter/'inventory.json').write_bytes((source/'inventory.json').read_bytes())
    (adapter/'global-assignment.json').write_text(json.dumps(dict(pdf_only=True,runtime_vlm_calls=0,truth_used=False,
        method='Historical unary callout evidence; compatibility adapter, not a global reassignment',evidence=evidence),indent=2))
    assign_slots(pdf,adapter,out/'fresh-slots')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--pdf',type=Path,required=True);p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.pdf,a.source,a.out)
