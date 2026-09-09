"""How often does the selection objective prefer the wrong assembly? Pooled.

Round seven measured, on 40377 and 41624 separately, that ten of twenty-one
retention losses are cases where the run's own native scorer ranks the reference
pose *below* what it chose. Round eight measured the same property in the class
round seven had filed as structurally unreachable, and found it there too. Both
measurements produce the same quantity - the best signed native delta of a legal
quota-preserving edit that introduces one reference instance - so they pool, and
pooled they answer a question neither fixture answers alone:

    of the reference instances a legal edit can reach at all, on what share does
    the objective that selects prefer the assembly the run already had?

That is the number that decides whether more search is worth building. A search
improvement can only ever convert an instance whose delta is positive; every
negative one is the objective being wrong about which assembly explains the
drawing, and is reachable only by changing the evidence.

Inputs are the artifacts the two tools already write - no re-driving, no GPU:

* `placement_retention_stage` mechanism tables (`--out`), one per fixture, whose
  per-target probes carry `best_native_delta` for the one-swap edits;
* `placement_retention_stage --double-probe` outputs, one per structural page,
  whose targets carry `best_native_delta` for the two-placement edits.

Counted in **distinct reference instances**, never per-page opportunities: a
target the allocation offers on four pages would otherwise count four times, and
the strongest edit available on any of its pages is the one a fix would have to
beat. Evaluation-only; both inputs read the reference model strictly after the
run and neither selects anything.
"""
import argparse
import json
from pathlib import Path


def pool(mechanism_paths, double_paths):
    """Best native delta per distinct reference instance, from both probe kinds."""
    instances = {}

    def record(fixture, truth_index, part, color, page, kind, delta, reachable):
        key = (fixture, int(truth_index))
        row = instances.setdefault(key, dict(fixture=fixture, truth_index=int(truth_index),
                                             part=part, color=int(color), pages=[],
                                             best_native_delta=None, best_kind=None,
                                             any_legal_edit=False))
        row['pages'].append(int(page))
        row['any_legal_edit'] |= bool(reachable)
        if delta is None:
            return
        if row['best_native_delta'] is None or delta > row['best_native_delta']:
            row['best_native_delta'] = float(delta)
            row['best_kind'] = kind

    for path in mechanism_paths:
        report = json.loads(Path(path).read_text())
        fixture = Path(report['truth']).stem
        for page in report['pages']:
            for target in page['targets']:
                if target.get('stage') != 'lost_to_search_retention':
                    continue
                deltas = [p['best_native_delta'] for p in target.get('probes', [])
                          if p.get('best_native_delta') is not None]
                legal = any(p.get('any_legal_assembly') for p in target.get('probes', []))
                record(fixture, target['truth_index'], target['part'], target['color'],
                       page['page'], 'one_swap', max(deltas) if deltas else None, legal)

    for path in double_paths:
        report = json.loads(Path(path).read_text())
        fixture = Path(report['truth']).stem
        for target in report['targets']:
            if target.get('already_selected') or target.get('single_swap_legal'):
                continue
            record(fixture, target['truth_index'], target['part'], target['color'],
                   report['page'], 'compound', target.get('best_native_delta'),
                   bool(target.get('compound_assemblies')))

    rows = sorted(instances.values(), key=lambda r: (r['fixture'], r['truth_index']))
    measured = [r for r in rows if r['best_native_delta'] is not None]
    positive = [r for r in measured if r['best_native_delta'] > 0]
    per_fixture = {}
    for row in rows:
        bucket = per_fixture.setdefault(row['fixture'],
                                        dict(instances=0, measured=0, positive=0,
                                             no_legal_edit=0))
        bucket['instances'] += 1
        if row['best_native_delta'] is None:
            bucket['no_legal_edit'] += 1
        else:
            bucket['measured'] += 1
            bucket['positive'] += 1 if row['best_native_delta'] > 0 else 0
    return dict(instances=len(rows), measured=len(measured), positive=len(positive),
                objective_prefers_its_own=len(measured) - len(positive),
                objective_gap_share=(1 - len(positive) / len(measured)) if measured else None,
                no_legal_edit=len(rows) - len(measured), per_fixture=per_fixture, rows=rows,
                truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                limitations='Pooled over the instances the two probes measured, which are the '
                            'instances that survived the occupancy screen and entered no '
                            'retained assembly - not the whole reference model. Each delta is '
                            'the best legal edit of the assembly the run selected on one page, '
                            'so it bounds what a better search reaches FROM THAT START, not '
                            'what a differently driven chain would reach.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mechanism', type=Path, nargs='+', required=True)
    parser.add_argument('--double', type=Path, nargs='*', default=[])
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = pool(args.mechanism, args.double)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))
    print(f"{report['instances']} distinct instances, {report['measured']} with a legal edit, "
          f"{report['positive']} the objective would take, "
          f"{report['objective_prefers_its_own']} it prefers its own "
          f"({100 * (report['objective_gap_share'] or 0):.1f}%), "
          f"{report['no_legal_edit']} with no legal edit at all")
    for fixture, bucket in sorted(report['per_fixture'].items()):
        print(f"  {fixture:>10}: {bucket}")
    for row in report['rows']:
        delta = ('     -' if row['best_native_delta'] is None
                 else f"{row['best_native_delta']:+.6f}")
        print(f"  {row['fixture']:>10} ti {row['truth_index']:>3} "
              f"{row['part']:>10}:{row['color']:<4} pages {sorted(set(row['pages']))} "
              f"{delta} {row['best_kind'] or 'unreachable'}")
    print(args.out)


if __name__ == '__main__':
    main()
