"""Post-hoc stage evaluation, never a truth-guided selection function."""
from pathlib import Path
from collections import Counter
import json,sys
from pose_score import read_parts,score

if __name__=='__main__':
    run=Path(sys.argv[1])
    truth=read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')
    pair=[p for p in truth if p[0] in ('99780','15571')]
    stages=[]
    for folder in [*sorted(run.glob('page_*_beams')),run]:
        rows=[]
        for path in sorted(folder.glob('beam_*.ldr')):
            parts=read_parts(path);n=len(parts)
            ids=Counter(p[:2] for p in parts);prefixids=Counter(p[:2] for p in truth[:n])
            rows.append({'file':str(path.relative_to(run)),'parts':n,'whole_truth':score(parts,truth),'prefix_inventory_exact':ids==prefixids,'prefix_missing':[{'part':p,'color':c,'qty':qty} for (p,c),qty in (prefixids-ids).items()],'prefix_extra':[{'part':p,'color':c,'qty':qty} for (p,c),qty in (ids-prefixids).items()],'prefix_pose':score(parts,truth[:n]),'first_pair':score([p for p in parts if p[0] in ('99780','15571')],pair)})
        stages.append({'stage':folder.name,'selected':rows[0],'oracle_best':max(rows,key=lambda r:r['whole_truth']['matched']),'correct_pair_beams':[r['file'] for r in rows if r['first_pair']['matched']==2],'results':rows})
    out=Path('output/pdf-placement-diagnosis')/(run.name+'-stages.json')
    out.write_text(json.dumps({'scope':'Post-hoc OMR evaluation only. Oracle best beam never selects runtime output. Whole-truth precision is primary; prefix ID discrepancies disclosed.','stages':stages},indent=2));print(out)
