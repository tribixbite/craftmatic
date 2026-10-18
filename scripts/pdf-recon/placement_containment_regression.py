"""Replay a driven run's containment and camera gate under a changed rule.

Changing which registrations survive containment changes which pages the driver
can drive, so the change has to be shown against every page a run already
recorded rather than against the one page it was written for. Everything the
replay needs is already saved: `registration-refined-*.json` holds each
hypothesis's measured overflow, occupied and covered pixels at its best offset,
and `camera-gate-*.json` holds the previous accepted scale, the measured drawing
ratio and the addable CAD area the verdict was computed against. So the table
below is a re-evaluation of recorded measurements, not a re-run - it renders
nothing, places nothing and cannot disagree with the run about what was measured.

What it can and cannot show: it reproduces the *admission* and the *camera
verdict* exactly, because both are closed-form functions of those numbers. It
cannot show what the search would then select, since that requires rendering
candidate assemblies; a page whose accepted registration changes is reported as
changed and has to be driven to know what it places.

No reference model, set inventory or VLM participates.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from placement_camera_gate import verdict as camera_verdict
from placement_origin_refine import overflow_ratio, relative_allowances


def admissions(evaluated, tolerance, fraction, multiple, cap):
    """Which recorded hypotheses are admitted, and how, under one rule."""
    rows = [row for row in evaluated if row.get('best_containment') is not None]
    allowances, floor, ceiling = relative_allowances(rows, multiple, cap)
    admitted = []
    for row in rows:
        best = row['best_containment']
        absolute = max(tolerance, int(fraction * best['occupied_pixels']))
        # The run's own verdict for the absolute rule is authoritative: it
        # searched offsets in a preferred order and stopped at the first
        # containing one, which `best_containment` need not be.
        if row.get('contained') and row.get('admission', 'absolute') == 'absolute':
            # A row the run accepted carries the accepted offset's own counts at
            # the top level; fall back to the measured best when it does not, so
            # a record written by an older or partial writer still replays.
            kind = 'absolute'
            source = row if 'outside_pixels' in row else dict(row, **best)
        elif best['outside_pixels'] <= absolute:
            kind, source = 'absolute', dict(row, **best)
        elif row['source_index'] in allowances and \
                best['outside_pixels'] <= allowances[row['source_index']]:
            kind, source = 'relative', dict(row, **best)
        else:
            continue
        admitted.append(dict(source_index=row['source_index'], admission=kind,
                             template_score=row.get('template_score'),
                             projection=source['projection'],
                             outside_pixels=source['outside_pixels'],
                             occupied_pixels=source['occupied_pixels'],
                             covered_pixels=source.get('covered_pixels'),
                             target_pixels=source.get('target_pixels'),
                             overflow_ratio=overflow_ratio(best),
                             contained=True, containment_fallback=False))
    return admitted, floor, ceiling


def order(admitted, propagated, coverage_order):
    """The driver's ordering: propagated first, then score or coverage."""
    def rank(row):
        if coverage_order:
            return -(row.get('covered_pixels') or 0)
        return -(row['template_score'] if row['template_score'] is not None else 0.0)
    return sorted(admitted, key=lambda row: (row['source_index'] >= propagated, rank(row)))


def replay(step, tolerance, fraction, multiple, cap, coverage_order):
    """Every drawing of one page under one containment rule."""
    out = []
    for path in sorted(step.glob('registration-refined-*.json')):
        refined = json.loads(path.read_text())
        gate_path = step / path.name.replace('registration-refined-', 'camera-gate-')
        gate = json.loads(gate_path.read_text()) if gate_path.is_file() else {}
        propagated = refined.get('drawing_registration_hypotheses') or 0
        admitted, floor, ceiling = admissions(refined['evaluated'], tolerance, fraction,
                                              multiple, cap)
        ranked = order(admitted, propagated, coverage_order)
        verdicts = [camera_verdict(row, gate.get('prior_px_per_ldu'), gate.get('addable_pixels'),
                                   gate.get('unexplained_max', 1.0),
                                   gate.get('scale_tolerance', .06),
                                   gate.get('drawing_ratio'))
                    for row in ranked]
        accepted = [(row, v) for row, v in zip(ranked, verdicts) if v['accepted']]
        out.append(dict(drawing=path.name, xref=refined.get('xref'), propagated=propagated,
                        overflow_ratio_floor=floor, relative_ratio_ceiling=ceiling,
                        admitted=len(admitted),
                        relative_admissions=sum(1 for r in admitted
                                                if r['admission'] == 'relative'),
                        accepted=len(accepted),
                        first_accepted=(accepted[0][0]['source_index'] if accepted else None),
                        first_admission=(accepted[0][0]['admission'] if accepted else None),
                        first_source=('drawing_to_drawing'
                                      if accepted and accepted[0][0]['source_index'] < propagated
                                      else ('body_template' if accepted else None)),
                        first_coverage=(accepted[0][1]['coverage'] if accepted else None),
                        first_outside=(accepted[0][0]['outside_pixels'] if accepted else None),
                        refusals=sorted({reason for _, v in zip(ranked, verdicts)
                                         for reason in v['reasons']}) if not accepted else []))
    return out


def page_number(step):
    return int(step.name.split('-')[1])


def run(root, tolerance, fraction, multiple, cap, coverage_order):
    steps = sorted((p for p in root.glob('page-*') if p.is_dir()),
                   key=lambda p: (page_number(p), p.name))
    rows = []
    for step in steps:
        before = replay(step, tolerance, fraction, 0.0, cap, False)
        after = replay(step, tolerance, fraction, multiple, cap, coverage_order)
        for old, new in zip(before, after):
            rows.append(dict(step=step.name, page=page_number(step), drawing=old['drawing'],
                             xref=old['xref'], before=old, after=new,
                             changed=(old['first_accepted'] != new['first_accepted']
                                      or bool(old['accepted']) != bool(new['accepted']))))
    return dict(run=str(root), rows=rows,
                pages=sorted({r['page'] for r in rows}),
                changed_drawings=[dict(step=r['step'], drawing=r['drawing'],
                                       before=r['before']['first_accepted'],
                                       after=r['after']['first_accepted'])
                                  for r in rows if r['changed']],
                rule=dict(tolerance=tolerance, fraction=fraction, relative_multiple=multiple,
                          relative_cap=cap, coverage_order=coverage_order),
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol='Re-evaluates each recorded hypothesis\'s saved overflow, occupied and '
                         'covered pixel counts under both containment rules and re-runs the saved '
                         'camera-gate criteria on the survivors',
                limitations='Admission and the camera verdict are reproduced exactly because both '
                            'are closed-form in the recorded numbers. What the search would then '
                            'select is not: a drawing whose accepted registration changes has to '
                            'be driven to know what it places. A page the run never reached has no '
                            'record to replay.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('run', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--tolerance', type=int, default=0)
    parser.add_argument('--fraction', type=float, default=0.01)
    parser.add_argument('--relative-multiple', type=float, default=4.0)
    parser.add_argument('--relative-cap', type=float, default=0.03)
    parser.add_argument('--coverage-order', action='store_true')
    args = parser.parse_args()
    result = run(args.run, args.tolerance, args.fraction, args.relative_multiple,
                 args.relative_cap, args.coverage_order)
    header = ('page drawing              before                     after')
    print(header)
    for row in result['rows']:
        before, after = row['before'], row['after']
        def cell(entry):
            if entry['first_accepted'] is None:
                return 'refused'
            return ('idx%-2d %-17s cov %.3f' % (entry['first_accepted'], entry['first_source'],
                                                entry['first_coverage'] or 0))
        print('%4d %-20s %-32s %-32s %s' % (row['page'], row['drawing'], cell(before), cell(after),
                                            'CHANGED' if row['changed'] else ''))
    print(json.dumps(dict(pages=len(result['pages']), drawings=len(result['rows']),
                          changed=len(result['changed_drawings']))))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2))
        print(args.out)
