"""Write compact, reviewable results from the saved trial evidence."""
import json
from collections import Counter
from pathlib import Path

OUT=Path(__file__).resolve().parents[2]/'output/pdf-recon-trials'
def read(name): return json.loads((OUT/name).read_text(encoding='utf-8'))

data=read('artwork.json')
matching=read('matching-results.json')
reuse=read('artwork-reuse-results.json')
transfer=read('step-transfer-results.json')
ranking=read('placement-rank-results.json')
summary={'dataset':{'booklets':len(data['booklets']),'icons':len(data['records']),
    'booklet_splits':dict(Counter(r['split'] for r in data['booklets'])),
    'forbidden_training_sets':data['forbidden_training_sets']},'icon_test':{},
    'step_transfer':transfer['summary'],'reuse':{k:reuse[k] for k in ['booklets','booklets_with_callouts','callouts']},
    'placement':ranking['folds'],
    'training':{k:matching[k] for k in ['device','parameters','steps','best_step','seconds','peak_gpu_bytes','checkpoint_sha256']},
    'runtime_vlm_calls':0,'production_models_changed':0,
    'limitations':['Inventory test supplies correct color and scores only classes available in training',
                   'Exact normalized image duplicates excluded, near duplicates are not excluded',
                   'Same part designs occur in different set splits; not unseen-part generalization',
                   'BOM crop labels are automatically extracted and not all manually verified',
                   'Historical step labels contain visible contamination; scores are diagnostic only',
                   'Placement trials are permissive cached truth-state replays, not full-model reconstruction']}
for method,stats in [('pixels',matching['baselines']['pixels']['test']),('hog',matching['baselines']['hog']['test']),('cnn',matching['learned']['test'])]:
    summary['icon_test'][method]={k:stats[k] for k in ['queries','available','top1_available','top5_available']}
    summary['icon_test'][method]['accuracy_available']=stats['top1_available']/stats['available']
    summary['icon_test'][method]['accuracy_all_queries']=stats['top1_available']/stats['queries']
baseline=matching['baselines']['pixels']['test']['rows']
learned=matching['learned']['test']['rows']
summary['paired_icon_test']={'cnn_only_correct':sum(a['available'] and b['top1'] and not a['top1'] for a,b in zip(baseline,learned)),
                           'pixels_only_correct':sum(a['available'] and a['top1'] and not b['top1'] for a,b in zip(baseline,learned))}
(OUT/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(OUT/'summary.json')
