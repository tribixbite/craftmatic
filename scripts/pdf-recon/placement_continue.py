"""Continue a PDF-derived checkpoint through supported automatic page actions.

This is a quarantined incremental driver, not a certified whole-PDF pipeline.
Unsupported or ambiguous page structure stops with saved evidence. Reference
models, manual part poses, VLM calls and publication are absent.
"""
import argparse
import hashlib
import json
from pathlib import Path


def plan_page(evidence,unresolved=(),layout=None):
    if unresolved:return dict(kind='unsupported',reason='Unresolved PDF part callout',unresolved=list(unresolved))
    mains=[s for s in evidence['scenes'] if s['kind']=='main_scene']
    if len(mains)!=1:return dict(kind='unsupported',reason='Main scene is not uniquely identified')
    common=dict(target_xref=mains[0]['xref'],page=evidence['source_page'])
    if len(evidence['parts'])==1:return dict(kind='singleton',copies=1,**common)
    groups=evidence['pair_groups']
    if len(groups)==1 and groups[0]['kind']=='exploded_pair' and groups[0]['multiplier']==2:
        return dict(kind='repeated_exploded_pair',copies=2,group_xref=groups[0]['source_xref'],**common)
    if layout is not None and len(evidence['parts'])==6:
        numbered=layout.get('groups',[])
        if len(numbered)==1:
            group=numbered[0];sequence=group.get('sequence',[])
            if (group.get('kind')=='inset_group' and group.get('copy_count')==1
                and [s['number'] for s in sequence]==[1,2]
                and len(group.get('ordered_xrefs',[]))==2
                and common['target_xref'] not in group['ordered_xrefs']):
                return dict(kind='numbered_three_plus_three',copies=1,
                    group_xrefs=group['ordered_xrefs'],stage_size_hypothesis=3,
                    allocation_scope_hypothesis='All six page allocations belong to the inset',**common)
    return dict(kind='unsupported',reason='Page needs another group constructor or cross-page state',**common)


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resume_checkpoints(record,config):
    """Validate immutable inputs and completed artifacts before skipping work."""
    if record.get('resume_config')!=config:
        raise ValueError('Resume inputs/configuration changed or legacy journal lacks input hashes')
    completed={}
    for step in record['steps']:
        if 'placement' not in step:continue
        path=Path(step['placement'])
        for filename,digest in step.get('checkpoint_hashes',{}).items():
            if not (path/filename).is_file() or file_hash(path/filename)!=digest:
                raise ValueError(f'Completed checkpoint changed: {path/filename}')
        if set(step.get('checkpoint_hashes',{}))!={'model.ldr','results.json'}:
            raise ValueError('Completed checkpoint lacks required hashes')
        if step['page'] in completed:raise ValueError('Duplicate completed page in journal')
        completed[step['page']]=path
    expected=list(range(config['first'],config['first']+len(completed)))
    if sorted(completed)!=expected:raise ValueError('Completed pages are not a contiguous prefix')
    return completed


def run(pdf,allocation_run,base_run,first,last,out,plan_only=False,coarse_pairs=256,coarse_method='layers',resume=False,numbered_insets=False):
    if out.exists() and not resume:raise ValueError('Choose a new output directory or explicitly resume')
    if resume and not out.exists():raise ValueError('Resume directory does not exist')
    if first<0 or last<first:raise ValueError('Invalid zero-indexed page interval')
    from placement_pdf_group_evidence import extract
    assignment=json.loads((allocation_run/'global-assignment.json').read_text())
    base_manifest=base_run/'manifest.json'
    if not base_manifest.exists():base_manifest=base_run/'results.json'
    config=dict(pdf_sha256=file_hash(pdf),allocation_sha256=file_hash(allocation_run/'global-assignment.json'),
        base_model_sha256=file_hash(base_run/'model.ldr'),base_manifest_sha256=file_hash(base_manifest),
        first=first,last=last,plan_only=plan_only,
        coarse_pairs=coarse_pairs,coarse_method=coarse_method,numbered_insets=numbered_insets,version=1)
    record=dict(pdf=str(pdf.resolve()),pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(),
        base_source=str(base_run),runtime_vlm_calls=0,truth_used=False,certified=False,
        plan_only=plan_only,steps=[],status='running',resume_config=config,
        limitations=['Starts from an existing PDF-derived checkpoint',
                    'Only singleton, repeated exploded-pair and opt-in bounded numbered-inset pages are dispatched',
                    'Selected checkpoints freeze earlier poses; no global backtracking yet',
                    'No complete-model or population certification; no publication'])
    completed={}
    if resume:
        record=json.loads((out/'continuation.json').read_text())
        completed=resume_checkpoints(record,config)
        record['status']='running';record.pop('error',None)
    else:out.mkdir(parents=True)
    def persist():
        temporary=out/'continuation.json.tmp'
        temporary.write_text(json.dumps(record,indent=2),encoding='utf-8')
        temporary.replace(out/'continuation.json')
    current=completed[max(completed)] if completed else base_run;persist()
    try:
        for page in range(first,last+1):
            if page in completed:continue
            page_dir=out/f'page-{page:03d}';attempt=1
            while page_dir.exists():
                attempt+=1;page_dir=out/f'page-{page:03d}-attempt-{attempt}'
            page_dir.mkdir()
            evidence=extract(pdf,page,allocation_run,page_dir/'evidence')
            unresolved=[r for r in assignment.get('unresolved',[]) if r['page']==page]
            layout=None
            if numbered_insets:
                import pymupdf
                from placement_step_graph import extract_layout,layout_graph
                with pymupdf.open(pdf) as doc:layout=layout_graph(extract_layout(doc,page,assignment))
                (page_dir/'layout.json').write_text(json.dumps(layout,indent=2),encoding='utf-8')
            action=plan_page(evidence,unresolved,layout)
            record['steps'].append(dict(action,evidence=str(page_dir/'evidence/results.json')));persist()
            if action['kind']=='unsupported':
                if plan_only:continue
                record['status']='stopped_unsupported_page';break
            if plan_only:continue
            if action['kind']=='numbered_three_plus_three':
                from placement_multistage_inset_trial import run as first_stage
                from placement_multistage_complete_trial import run as complete_group
                first_stage(pdf,page,allocation_run,page_dir/'stage1',stage_size=3)
                complete_group(page_dir/'stage1',page_dir/'group')
            elif action['kind']=='singleton':
                from placement_allocated_singleton import run as construct
                construct(pdf,page,allocation_run,page_dir/'group')
            else:
                from placement_allocated_pair_trial import run as construct
                construct(pdf,page,allocation_run,page_dir/'group',feature_edges=True,arrow_halo=True,insertion_contacts=True)
            from placement_attach_group import run as attach
            attach(pdf,current,page_dir/'group',page,page_dir/'placement',limit=20,
                   gpu_render=True,camera_mode='multirow',any_anchor=True,plane_depth=True,
                   copies=action['copies'],coarse_pairs=coarse_pairs,
                   coarse_method=coarse_method,target_xref=action['target_xref'],feature_edges=True,material_colors=True)
            current=page_dir/'placement';record['steps'][-1]['placement']=str(current)
            record['steps'][-1]['checkpoint_hashes']={name:file_hash(current/name) for name in ('model.ldr','results.json')}
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
    p.add_argument('--resume',action='store_true')
    p.add_argument('--numbered-insets',action='store_true',help='Enable bounded six-piece / two-numbered-stage constructor')
    p.add_argument('--coarse-pairs',type=int,default=256);p.add_argument('--coarse-method',choices=['surface','layers'],default='layers')
    a=p.parse_args();run(a.pdf,a.allocation_run,a.base_run,a.first,a.last,a.out,a.plan_only,a.coarse_pairs,a.coarse_method,a.resume,a.numbered_insets)
