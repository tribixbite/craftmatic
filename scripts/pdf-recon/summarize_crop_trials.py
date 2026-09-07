import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/pdf-crop-trial'
read=lambda p:json.loads(p.read_text(encoding='utf-8'))
raw=read(OUT/'results.json')
gold=read(OUT/'gold-scores.json')
report={'crop_extraction':{k:raw[k] for k in ['old_crops','anchors','resolved_crops']},
        'gold_development':{m:{k:r[k] for k in ['correct','total']} for m,r in gold['results'].items()},
        'runs':[], 'runtime_vlm_calls':0,'production_changed':False}
for name in ['41624-contact','41624-cnn-contact','40377-cnn-template','40377-cnn-placement']:
    run=OUT/name
    pose=read(run/'pose.json')
    manifest=read(run/'manifest.json')
    report['runs'].append({'name':name,'pose':{k:pose[k] for k in ['matched','truth_parts','recon_parts','coverage','precision','inventory_coverage','inventory_precision']},
        'pdf_only':manifest['pdf_only'],'runtime_vlm_calls':manifest['runtime_vlm_calls'],
        'model_sha256':hashlib.sha256((run/'model.ldr').read_bytes()).hexdigest()})
report['limitations']=['Eleven gold examples are visually selected development data, not representative held-out accuracy',
                      'Part mold identity follows catalog mapping; equivalent geometry not quotiented',
                      'New crop extraction rejects more anchors and regresses full inventory coverage',
                      'CNN placement remains dependent on the existing camera fit and candidate generator']
(OUT/'summary.json').write_text(json.dumps(report,indent=2))
print(OUT/'summary.json')
