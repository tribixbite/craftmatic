"""Independent post-hoc pair-file evaluation; never runtime selection."""
from pathlib import Path
import json,sys
from pose_score import read_parts,score
from placement_diagnose import position_upper

if __name__=='__main__':
    run=Path(sys.argv[1]);truth=[p for p in read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd') if p[0] in ('99780','15571')]
    rows=[]
    for path in sorted(run.glob('pair_*.ldr')):
        parts=read_parts(path)
        rows.append({'file':path.name,'strict':score(parts,truth),'position_only':position_upper(parts,truth)})
    output={'scope':'Post-hoc independent OMR evaluation, not runtime selection','run':str(run),'count':len(rows),'selected':rows[0],'exact_pair_ranks':[i+1 for i,r in enumerate(rows) if r['strict']['matched']==2],'position_pair_ranks':[i+1 for i,r in enumerate(rows) if r['position_only']['matched']==2],'results':rows}
    out=Path('output/pdf-placement-diagnosis')/(run.name+'-evaluation.json');out.write_text(json.dumps(output,indent=2));print(out)
