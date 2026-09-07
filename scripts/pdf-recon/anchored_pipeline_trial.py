"""Run the PDF-only assembler with opt-in quantity-anchored extraction."""
import argparse
from collections import Counter
from pathlib import Path
import sys
from pdf_crop_trial import crop_items,artwork_pixels

BASE=Path('C:/git/clego')
sys.path.insert(0,str(BASE))


def run(pdf,out,strategy,matcher='synthetic',placement_matcher='template',joint=False,
        candidate_budget=90,page_prefilter=False):
    from recon_extract import q1_deterministic as q1, extract_e4 as e4
    from recon_extract.pdf_inventory import is_inventory_page
    from recon_extract.pdf_pipeline import reconstruct
    original=q1.DeterministicQ1Front
    from recon_v8 import template
    from recon_v8 import place
    original_rank=place.rank_candidates
    def trial_rank(*args,**kwargs):
        kwargs.update(budget=candidate_budget,k=candidate_budget,page_prefilter=page_prefilter)
        return original_rank(*args,**kwargs)
    place.rank_candidates=trial_rank
    original_locate=template.locate
    fronts=[]
    class AnchoredFront(original):
        def __init__(self,*args,**kwargs):
            super().__init__(*args,**kwargs)
            fronts.append(self)
            if matcher=='cnn':
                from frozen_pdf_matcher import FrozenPdfMatcher
                self.resolver=FrozenPdfMatcher(self.doc)
                if placement_matcher=='cnn': template.locate=self.resolver.locate
                if joint:
                    from global_pdf_assignment import assign
                    self.allocations,self.assignment_report=assign(self.doc,self.style,args[1],self.resolver,out)
        def adds_for_page(self,pg,rows):
            if is_inventory_page(self.doc[pg]):
                return {'adds':[],'needs_vlm':False,'page_role':'inventory'},'inventory'
            if joint:
                adds=self.allocations.get(pg,[])
                missing=[r for r in self.assignment_report['unresolved'] if r['page']==pg]
                return {'adds':adds,'needs_vlm':False,'unresolved':bool(missing),
                        'where':'joint PDF inventory-capacity assignment','unresolved_crops':missing},'joint assignment'
            rgb=e4.render_page(self.doc,pg)
            tokens=e4.page_tokens(self.doc,pg,style=self.style,pdf_path=self.pdf)
            items=crop_items(rgb,self.doc[pg].get_text('words'),tokens['qty_small'],self.style.pli_bg)
            rgb=artwork_pixels(rgb,self.doc[pg].get_text('words'),self.style.pli_bg)
            remaining=Counter((q1._norm_part(p),str(c)) for c,p,w,h,d,n in rows for _ in range(n))
            pooled=Counter()
            unresolved=[]
            evidence=[]
            for item in items:
                if 'bbox' not in item:
                    unresolved.append(item)
                    continue
                x0,y0,x1,y1=item['bbox']
                match=self.resolver.match(rgb[y0:y1,x0:x1],self.style.pli_bg,qty=item['qty'],remaining=remaining)
                if not match or match['score']<q1.MATCH_SCORE_MIN:
                    unresolved.append(dict(item,reason='unmatched artwork'))
                    continue
                index=self._row_index(rows,q1._norm_part(match['part']),q1._norm_color(match['color']))
                if index is None:
                    unresolved.append(dict(item,reason='no available row'))
                    continue
                pooled[index]+=item['qty']
                evidence.append(dict(item,part=match['part'],color=match['color'],score=float(match['score'])))
            adds=[{'index':i,'qty':min(qty,rows[i][-1])} for i,qty in pooled.items()]
            expected=sum(q['qty'] for q in items)
            emitted=sum(a['qty'] for a in adds)
            self.stats['pages_processed']+=1
            self.stats['items_found']+=len(evidence)
            ans={'adds':adds,'needs_vlm':False,'unresolved':bool(unresolved) or expected!=emitted,
                 'where':'quantity-anchored deterministic extraction','expected_qty':expected,'emitted_qty':emitted,
                 'crop_evidence':evidence,'unresolved_crops':unresolved}
            return ans,ans['where']
    q1.DeterministicQ1Front=AnchoredFront
    try:
        result=reconstruct(pdf,out,strategy=strategy)
        import hashlib,json
        result['experimental_extractor']='quantity-anchored-v1'
        result['experimental_matcher']=matcher
        result['joint_assignment']=joint
        result['candidate_budget']=candidate_budget
        result['page_prefilter']=page_prefilter
        result['experimental_placement_matcher']=placement_matcher
        result['trial_code_sha256']={p.name:hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [Path(__file__),Path(__file__).with_name('pdf_crop_trial.py'),Path(__file__).with_name('frozen_pdf_matcher.py'),Path(__file__).with_name('global_pdf_assignment.py')]}
        if matcher=='cnn':
            result['references']='pdf_cnn'
            result['cnn_placement_stats']=fronts[0].resolver.placement_stats
            checkpoint=fronts[0].resolver.checkpoint_path
            result['checkpoint_path']=str(checkpoint)
            result['checkpoint_sha256']=hashlib.sha256(checkpoint.read_bytes()).hexdigest()
        (out/'manifest.json').write_text(json.dumps(result,indent=2))
        return result
    finally:
        q1.DeterministicQ1Front=original
        template.locate=original_locate
        place.rank_candidates=original_rank


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('pdf',type=Path)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--strategy',choices=['contact','template'],default='contact')
    p.add_argument('--matcher',choices=['synthetic','cnn'],default='synthetic')
    p.add_argument('--placement-matcher',choices=['template','cnn'],default='template')
    p.add_argument('--joint',action='store_true')
    p.add_argument('--candidate-budget',type=int,default=90)
    p.add_argument('--page-prefilter',action='store_true')
    a=p.parse_args()
    if a.placement_matcher=='cnn' and (a.matcher!='cnn' or a.strategy!='template'):
        p.error('CNN placement requires --matcher cnn --strategy template')
    if a.joint and a.matcher!='cnn': p.error('--joint requires --matcher cnn')
    if a.candidate_budget<1: p.error('--candidate-budget must be positive')
    run(a.pdf,a.out,a.strategy,a.matcher,a.placement_matcher,a.joint,a.candidate_budget,a.page_prefilter)
