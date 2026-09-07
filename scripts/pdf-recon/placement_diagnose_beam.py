"""Post-hoc beam evaluation; oracle results NEVER select runtime output."""
import json
from pathlib import Path
import sys
from pose_score import read_parts, score

if __name__ == '__main__':
    run=Path(sys.argv[1])
    manifest=json.loads((run/'manifest.json').read_text())
    if manifest['status']!='complete_approximate':raise ValueError('Wait for completed beam')
    truth=read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')
    prefix=truth[:6]
    # Both identifiers are unique in this fixture, so selecting the first pair
    # does not resolve duplicate identities with a truth-guided assignment.
    pair=[p for p in prefix if p[0] in ('99780','15571')]
    results=[]
    for path in [run/'model.ldr',*sorted(run.glob('beam_*.ldr'))]:
        recon=read_parts(path)
        entry={'file':path.name,'first_six_truth':score(recon,prefix),'entire_truth':score(recon,truth),'first_pair':score([p for p in recon if p[0] in ('99780','15571')],pair)}
        results.append(entry)
    report={'scope':'Post-hoc independent OMR evaluation only. Oracle best beam is not a model output or selection rule. Six-part prefix is not whole-model accuracy.','run':str(run),'selected':results[0],'oracle_best_beam_first_six':max(results[1:],key=lambda r:r['first_six_truth']['matched']),'correct_pair_beams':[r['file'] for r in results[1:] if r['first_pair']['matched']==2],'beams':results[1:]}
    out=Path('output/pdf-placement-diagnosis')/(run.name+'-evaluation.json')
    out.write_text(json.dumps(report,indent=2))
    print(out)
