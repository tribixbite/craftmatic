"""Continue a PDF-derived checkpoint through supported automatic page actions.

This is a quarantined incremental driver, not a certified whole-PDF pipeline.
Unsupported or ambiguous page structure stops with saved evidence. Reference
models, manual part poses, VLM calls and publication are absent.
"""
import argparse
import hashlib
import json
from pathlib import Path


def plan_page(evidence,unresolved=()):
    if unresolved:return dict(kind='unsupported',reason='Unresolved PDF part callout',unresolved=list(unresolved))
    mains=[s for s in evidence['scenes'] if s['kind']=='main_scene']
    if len(mains)!=1:return dict(kind='unsupported',reason='Main scene is not uniquely identified')
    common=dict(target_xref=mains[0]['xref'],page=evidence['source_page'])
    if len(evidence['parts'])==1:return dict(kind='singleton',copies=1,**common)
    groups=evidence['pair_groups']
    if len(groups)==1 and groups[0]['kind']=='exploded_pair' and groups[0]['multiplier']==2:
        return dict(kind='repeated_exploded_pair',copies=2,group_xref=groups[0]['source_xref'],**common)
    return dict(kind='unsupported',reason='Page needs another group constructor or cross-page state',**common)


def run(pdf,allocation_run,base_run,first,last,out,plan_only=False,coarse_pairs=256,coarse_method='layers'):
    if out.exists():raise ValueError('Choose a new output directory')
    if first<0 or last<first:raise ValueError('Invalid zero-indexed page interval')
    out.mkdir(parents=True)
    from placement_pdf_group_evidence import extract
    assignment=json.loads((allocation_run/'global-assignment.json').read_text())
    record=dict(pdf=str(pdf.resolve()),pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),
        base_source=str(base_run),runtime_vlm_calls=0,truth_used=False,certified=False,
        plan_only=plan_only,steps=[],status='running',
        limitations=['Starts from an existing PDF-derived checkpoint',
                    'Only singleton and repeated exploded-pair pages are dispatched',
                    'Selected checkpoints freeze earlier poses; no global backtracking yet',
                    'No complete-model or population certification; no publication'])
    def persist():
        (out/'continuation.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
    current=base_run;persist()
    try:
        for page in range(first,last+1):
            page_dir=out/f'page-{page:03d}';page_dir.mkdir()
            evidence=extract(pdf,page,allocation_run,page_dir/'evidence')
            unresolved=[r for r in assignment.get('unresolved',[]) if r['page']==page]
            action=plan_page(evidence,unresolved)
            record['steps'].append(dict(action,evidence=str(page_dir/'evidence/results.json')));persist()
            if action['kind']=='unsupported':
                if plan_only:continue
                record['status']='stopped_unsupported_page';break
            if plan_only:continue
            if action['kind']=='singleton':
                from placement_allocated_singleton import run as construct
            else:
                from placement_allocated_pair_trial import run as construct
            construct(pdf,page,allocation_run,page_dir/'group')
            from placement_attach_group import run as attach
            attach(pdf,current,page_dir/'group',page,page_dir/'placement',limit=20,
                   gpu_render=True,camera_mode='multirow',any_anchor=True,plane_depth=True,
                   copies=action['copies'],coarse_pairs=coarse_pairs if action['copies']==2 else 0,
                   coarse_method=coarse_method,target_xref=action['target_xref'],feature_edges=True)
            current=page_dir/'placement';record['steps'][-1]['placement']=str(current)
            record['last_checkpoint']=str(current);persist()
        else:record['status']='planned' if plan_only else 'completed_requested_pages_uncertified'
    except Exception as exc:
        record['status']='failed';record['error']=f'{type(exc).__name__}: {exc}';persist();raise
    persist()


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('pdf',type=Path)
    p.add_argument('--allocation-run',type=Path,required=True);p.add_argument('--base-run',type=Path,required=True)
    p.add_argument('--first',type=int,required=True);p.add_argument('--last',type=int,required=True)
    p.add_argument('--out',type=Path,required=True);p.add_argument('--plan-only',action='store_true')
    p.add_argument('--coarse-pairs',type=int,default=256);p.add_argument('--coarse-method',choices=['surface','layers'],default='layers')
    a=p.parse_args();run(a.pdf,a.allocation_run,a.base_run,a.first,a.last,a.out,a.plan_only,a.coarse_pairs,a.coarse_method)
