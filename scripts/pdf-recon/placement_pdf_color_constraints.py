"""Conservative PDF-to-PDF achromatic artwork incompatibility evidence.

Strong black-versus-white contradiction only. Colored parts, ambiguous lighting,
and neutral paper backgrounds abstain. Does not infer part IDs or stud counts.
"""
import numpy as np
from placement_callout_color_audit import descriptor


def signature(rgb):
    data=descriptor(rgb);bg=np.asarray(data['background'],float)
    data['class']='unknown';data['confident']=False
    # On white paper the remaining outlines of a white part can look black
    # after background subtraction. Require a chromatic light panel here.
    if bg.max()-bg.min()<25 or bg.max()<170 or data['neutral_pixels']<30 or data['neutral_fraction']<.8:return data
    if data['bright_fraction']>=.25 and data['value_quantiles'][2]>=210:data['class']='light_achromatic'
    elif data['bright_fraction']<=.03 and data['dark_fraction']>=.6 and data['value_quantiles'][3]<175:data['class']='dark_achromatic'
    data['confident']=data['class']!='unknown'
    return data


def constrain_scores(callouts,references,scores):
    scores=np.asarray(scores,float).copy()
    if scores.shape!=(len(callouts),len(references)):raise ValueError('Artwork/score dimensions mismatch')
    left=[signature(im) for im in callouts];right=[signature(im) for im in references];rejected=[]
    for i,a in enumerate(left):
        for j,b in enumerate(right):
            if a['confident'] and b['confident'] and a['class']!=b['class']:
                rejected.append(dict(callout=i,inventory_slot=j,previous_score=float(scores[i,j]),reason='Strong native-PDF light-versus-dark achromatic contradiction'));scores[i,j]=-np.inf
    return scores,dict(callouts=left,inventory=right,rejected=rejected,truth_used=False,runtime_vlm_calls=0,
        protocol='Native color evidence applied before capacity assignment; unknown classes remain eligible',
        limitations='Only high-confidence black/white contradiction on chromatic light panels; no guarantee for different lighting, neutral backgrounds, gray colors, or scale/stud-count matching.')
