"""Reopen a committed page and re-drive from it: page-level backtracking.

The driver's own recorded limitation is "Selected checkpoints freeze earlier
poses; no global backtracking". Every later page registers against, collides
with and scores against the body an earlier page committed, so one wrong
commitment is not one wrong page - it removes the reference poses of every later
page from the enumerated bank, which is why the two fixtures driven from their
own construction lose 58% and 63% of their models to `unreachable`.

What a reopening can reach, and what it cannot
----------------------------------------------
A page's search already wrote every assembly it retained (`beam_NN.ldr`, ranked,
with the objective score of each), so an alternative costs no re-search: it is a
file on disk. `placement_alternatives_oracle` measures what those files contain,
and the measurement decides where a budget belongs. On 41601, 15 of 17 driven
pages retain *nothing* better than what was selected - every retained body on
those pages carries the same three correct poses the construction supplied - so
reopening a driven page has almost nothing to reach. Its **construction** is the
opposite: 36 retained bodies, a 24-way exact tie at 3 of 7 correct, and twelve
bodies at 6 of 7 sitting 0.0132 of objective score below that tie.

So the site that matters is the opening, and the mechanism it needs is not a
better score - the objective prefers the worse body by a margin no tie-break
reaches - but a *decision made downstream*: drive each opening and let the
pages that follow say which opening was survivable.

The branch set is the objective's own indifference classes
----------------------------------------------------------
Retained bodies are grouped by exact objective score. Members of one exact tie
are genuinely different assemblies, but the objective states it cannot separate
them, and the measured structural spread inside such a tie is zero on every
class this program has censused. Branching therefore takes **one representative
per exact-score class** - the best-ranked member - which turns 36 retained
bodies into two branches on 41601's construction instead of thirty-six. Every
class and its census is recorded, so a class whose members do differ is visible
rather than assumed away.

Triggers, and the honest finding about them
-------------------------------------------
`assess` reads a branch's own journal for downstream contradiction:

* `registration_collapse` - a page that falls back to body-template registration
  *and* moves the camera scale by more than the tolerance. This is round eight's
  measured regression exactly: 40377 page 22 fell from `drawing_to_drawing` at
  1.6916 px/LDU onto `body_template` at 1.4863, and every later page inherited
  the wrong scale. A body-template fallback at a stable scale is common and
  harmless (three of 40377's pages, three of 41624's), so the scale movement is
  half the predicate, not decoration.
* `refusal_run` - `run` consecutive pages the camera gate refused. The driver's
  retry pass already repairs an isolated refusal (that is what it is for), so
  the default run length is three.
* `capacity_violation` - the pooled PDF inventory contradicts the committed body
  (`placement_capacity`). Composed here rather than scored inside a page.
* `score_trend` - opt-in, and weak: a 30% single-page score drop occurs in the
  chain that scored *better* structurally, so this predicate cannot separate the
  two cases that motivated it and is off by default.

Measured on four completed journals, the trigger set fires **once**: 40377's
compound chain at page 22. Neither from-scratch fixture produces a single
contradiction - 41601 registers `drawing_to_drawing` on all 17 placed pages at
IoU 0.73-0.98 with a monotone camera scale while carrying a 3-of-108 body. A
wrong opening is *silent* under every instrument the driver has. That is why
`always` exists as a trigger: it is the unconditional opening search, and on
these fixtures it is the only trigger that can fire at the site that matters.

Nothing here reads a reference model. Branch selection uses the branch journals
only, and the reference appears in the report `placement_alternatives_oracle`
writes afterwards, never in a choice.
"""
import argparse
import hashlib
import json
import shutil
import time
import traceback
from pathlib import Path

import placement_autodrive as autodrive

# A page whose only failure was a missing camera; the driver's retry pass exists
# for exactly these, so they are not by themselves evidence of a wrong body.
CAMERA_FAILURES = ('camera_unsupported', 'no_contained_registration', 'camera_refused')
# The camera scale tolerance the gate itself uses. A body-template fallback
# inside this band is ordinary; outside it the page is registering against a
# different-sized assembly than the one the drawings describe.
SCALE_TOLERANCE = 0.06
# Consecutive refused pages before the run is treated as a contradiction rather
# than as pages waiting for a later camera.
REFUSAL_RUN = 3
# Opt-in only: calibrated against exactly one positive and one negative example.
SCORE_DROP = 0.45


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def default_options():
    """The driver's own option defaults, for reconciling an older journal."""
    parser = argparse.ArgumentParser()
    autodrive.add_page_options(parser)
    return autodrive.build_options(parser.parse_args([]))


def score_classes(directory):
    """Retained assemblies of one placement directory, by exact objective score.

    Returns a list of classes in rank order, each carrying its representative
    (the best-ranked member), every member's rank, and the deduplicated body
    count - two registrations of one page can retain a byte-identical body and a
    budget spent on one of those buys nothing.
    """
    directory = Path(directory)
    meta = json.loads((directory / 'results.json').read_text())
    if meta.get('truth_used') is not False or meta.get('runtime_vlm_calls') != 0:
        raise ValueError('Placement provenance lacks truth-free zero-VLM declaration')
    classes, seen_digest = [], {}
    for rank, result in enumerate(meta.get('results') or []):
        path = directory / result['file']
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        # The score the run selected by. `combined_score` exists only when the
        # local rerank is on, and then it is the number that ordered the list.
        score = result['evidence'].get('combined_score', result['evidence']['score'])
        duplicate = seen_digest.get(digest)
        seen_digest.setdefault(digest, rank)
        if classes and classes[-1]['score'] == score:
            entry = classes[-1]
        else:
            entry = dict(score=score, representative=None, members=[], distinct_bodies=0,
                         digests=[])
            classes.append(entry)
        entry['members'].append(dict(rank=rank, file=result['file'], sha256=digest,
                                     view=result.get('view'), duplicate_of=duplicate,
                                     indices=list(result['coarse']['indices'])))
        if duplicate is None:
            entry['distinct_bodies'] += 1
            entry['digests'].append(digest)
        if entry['representative'] is None and duplicate is None:
            entry['representative'] = entry['members'][-1]
    return dict(directory=str(directory), page=meta.get('page'), classes=classes,
                retained=len(meta.get('results') or []),
                distinct_bodies=len(seen_digest))


def alternatives(directory, taken_digests=()):
    """Score-class representatives of a site that have not been driven yet."""
    census = score_classes(directory)
    taken = set(taken_digests)
    out = []
    for index, entry in enumerate(census['classes']):
        representative = entry['representative']
        if representative is None or representative['sha256'] in taken:
            continue
        out.append(dict(representative, score=entry['score'], score_class=index,
                        class_width=len(entry['members']),
                        class_distinct_bodies=entry['distinct_bodies']))
    return census, out


def derive_base(site, member, out, provenance):
    """A base-run directory whose model is one retained alternative.

    The driver consumes a checkpoint as `--base-run`: a directory holding
    `model.ldr` and a manifest with truth-free provenance, and - when drawing
    registration is on - a `results.json` whose first result names the view the
    checkpoint was built at, because `registration_of_run` seeds the propagation
    from that view. Reordering the retained list so the alternative comes first
    is therefore not cosmetic: it is what makes the branch propagate from the
    camera its own body was scored at.
    """
    site, out = Path(site), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((site / 'results.json').read_text())
    results = list(meta.get('results') or [])
    index = next(i for i, row in enumerate(results) if row['file'] == member['file'])
    meta = dict(meta, results=[results[index]] + results[:index] + results[index + 1:],
                backtrack=dict(source=str(site), taken_rank=member['rank'],
                               taken_file=member['file'], taken_sha256=member['sha256'],
                               taken_score=member['score'], score_class=member['score_class'],
                               **provenance))
    shutil.copyfile(site / member['file'], out / 'model.ldr')
    for name in ('registry.json', 'selected.png'):
        if (site / name).is_file():
            shutil.copyfile(site / name, out / name)
    (out / 'results.json').write_text(json.dumps(meta, indent=2))
    return out


def signals(journal):
    """Per-page downstream signals of one branch, main pass only.

    A retry-pass page is placed after every later page has already committed, so
    a contradiction recorded there has nothing downstream to repair and must not
    trigger a reopening.
    """
    rows, previous = [], None
    for step in journal.get('steps') or []:
        if step.get('retry_pass'):
            continue
        detail = step.get('detail') or {}
        row = dict(page=step['page'], status=step['status'],
                   registration_source=detail.get('registration_source'),
                   px_per_ldu=detail.get('selected_view_px_per_ldu'),
                   score=detail.get('score'), placement=step.get('placement'),
                   drawing_iou=detail.get('drawing_registration_iou'))
        if step['status'] == 'placed':
            row['previous_placed_page'] = previous['page'] if previous else None
            row['scale_change'] = (
                (row['px_per_ldu'] - previous['px_per_ldu']) / previous['px_per_ldu']
                if row['px_per_ldu'] and previous and previous['px_per_ldu'] else None)
            row['score_change'] = ((row['score'] - previous['score']) / previous['score']
                                   if row['score'] is not None and previous
                                   and previous.get('score') else None)
            previous = row
        rows.append(row)
    return rows


def assess(journal, triggers=('registration_collapse', 'refusal_run'),
           scale_tolerance=SCALE_TOLERANCE, refusal_run=REFUSAL_RUN, score_drop=SCORE_DROP,
           capacity=None):
    """Every trigger firing of one branch, in page order.

    `capacity` is an optional record from `placement_capacity.audit`; its
    `deficits` are pooled-inventory contradictions of the committed body, and a
    non-empty list fires `capacity_violation` at the page that produced it.
    """
    rows, firings = signals(journal), []
    streak = []
    for row in rows:
        if row['status'] in CAMERA_FAILURES:
            streak.append(row['page'])
            if 'refusal_run' in triggers and len(streak) == refusal_run:
                firings.append(dict(trigger='refusal_run', page=row['page'],
                                    evidence=dict(pages=list(streak), run=len(streak))))
        else:
            streak = []
        if row['status'] != 'placed':
            continue
        if ('registration_collapse' in triggers
                and row['registration_source'] == 'body_template'
                and row.get('scale_change') is not None
                and abs(row['scale_change']) > scale_tolerance):
            firings.append(dict(trigger='registration_collapse', page=row['page'],
                                evidence=dict(px_per_ldu=row['px_per_ldu'],
                                              previous_page=row['previous_placed_page'],
                                              scale_change=row['scale_change'],
                                              score=row['score'],
                                              score_change=row.get('score_change'))))
        if ('score_trend' in triggers and row.get('score_change') is not None
                and row['score_change'] < -abs(score_drop)):
            firings.append(dict(trigger='score_trend', page=row['page'],
                                evidence=dict(score=row['score'],
                                              score_change=row['score_change'],
                                              previous_page=row['previous_placed_page'])))
    for deficit in ((capacity or {}).get('deficits') or []):
        if 'capacity_violation' in triggers:
            firings.append(dict(trigger='capacity_violation', page=deficit.get('page'),
                                evidence=deficit))
    firings.sort(key=lambda row: (row['page'] if row['page'] is not None else -1,
                                  row['trigger']))
    return dict(signals=rows, firings=firings)


def branch_metrics(journal, inherited_pages=0, inherited_pieces=0):
    """Runtime-legal quality of a completed branch. No reference is read.

    Ordered as the selection rule reads them: a branch that placed more of the
    booklet explains more of the instrument, and among those a branch whose
    instruments contradict it less often is preferred. The image score enters
    last and only as a mean over placed pages, because a single page's score is
    not comparable across branches whose bodies differ.
    """
    rows = signals(journal)
    placed = [row for row in rows if row['status'] == 'placed']
    retried = [step for step in (journal.get('steps') or []) if step.get('retry_pass')
               and step.get('status') == 'placed']
    scores = [row['score'] for row in placed if row['score'] is not None]
    pieces = 0
    for step in (journal.get('steps') or []):
        detail = step.get('detail') or {}
        if detail.get('selected_parts'):
            pieces = max(pieces, int(detail['selected_parts']))
    verdict = assess(journal, triggers=('registration_collapse', 'refusal_run', 'score_trend'))
    return dict(placed_pages=len(placed) + len(retried) + inherited_pages,
                main_pass_placed=len(placed), retry_placed=len(retried),
                pieces_emitted=max(pieces, inherited_pieces),
                unplaced_pages=[row['page'] for row in rows if row['status'] != 'placed'],
                camera_failures=sum(1 for row in rows if row['status'] in CAMERA_FAILURES),
                registration_collapses=sum(1 for row in verdict['firings']
                                           if row['trigger'] == 'registration_collapse'),
                score_collapses=sum(1 for row in verdict['firings']
                                    if row['trigger'] == 'score_trend'),
                mean_page_score=(sum(scores) / len(scores)) if scores else None,
                final_page_score=scores[-1] if scores else None,
                last_checkpoint=journal.get('last_checkpoint'),
                status=journal.get('status'))


SELECTION_KEYS = dict(
    # More of the booklet placed, then more pieces emitted, then fewer instrument
    # contradictions, then the mean page agreement. Every term is computable from
    # the branch's own journal.
    downstream=lambda metrics: (metrics['placed_pages'], metrics['pieces_emitted'],
                                -metrics['camera_failures'],
                                -metrics['registration_collapses'],
                                metrics['mean_page_score'] or 0.),
    # Contradictions first, coverage second. Measured after the fact on the two
    # branches this round drove: `downstream` chose the worse model on *both*
    # (3 of 108 over 6, and 51 of 90 over 53), while ordering the instrument
    # contradictions ahead of the coverage terms would have chosen the better
    # model on both - 40377 on the registration collapse, 41601 on the camera
    # failures. That is a rule fitted to two observations and it is offered as a
    # hypothesis for the next round to test, not as a validated criterion.
    contradictions=lambda metrics: (-metrics['registration_collapses'],
                                    -metrics['camera_failures'],
                                    metrics['placed_pages'], metrics['pieces_emitted'],
                                    metrics['mean_page_score'] or 0.),
    # The control: the objective alone, which is what the driver does today.
    objective=lambda metrics: (metrics['mean_page_score'] or 0.,),
    # The control that changes nothing, for an A/B that isolates the branch set.
    first=lambda metrics: (0,))


def select(branches, rule='downstream'):
    """The branch the run reports, by a stated runtime-legal rule."""
    key = SELECTION_KEYS[rule]
    ordered = sorted(branches, key=lambda entry: (key(entry['metrics']), -entry['index']),
                     reverse=True)
    return ordered[0], [entry['index'] for entry in ordered]


def reopen_sites(branch, order='base-first'):
    """Candidate reopening sites of a driven branch, in the policy's order.

    * `base-first` puts the checkpoint the branch started from first, then its
      pages earliest-first. This is the policy the measurement supports: the
      opening is where the retained sets actually differ.
    * `nearest` puts the latest committed page first, which is the cheapest
      reopening (fewest pages to re-drive) and the right one when a trigger
      names a page whose predecessor is the suspect - 40377's page 22 collapse
      after page 19's body changed.
    * `earliest` ignores the base and walks pages forwards.
    """
    pages = [(row['page'], row['placement']) for row in signals(branch['journal'])
             if row['status'] == 'placed' and row.get('placement')]
    base = [(None, branch['base'])]
    if order == 'base-first':
        return base + pages
    if order == 'earliest':
        return pages + base
    if order == 'nearest':
        return list(reversed(pages)) + base
    raise ValueError(f'Unknown reopen order {order!r}')


def drive(pdf, allocation_run, base_run, pages, out, options, label, parent=None,
          inherited_pages=0, inherited_pieces=0):
    """One branch: an ordinary driver run, recorded with its lineage."""
    started = time.perf_counter()
    try:
        journal = autodrive.run(pdf, allocation_run, Path(base_run), pages, Path(out), options,
                                stop_on_unsupported=False)
        error = None
    except Exception as exc:  # a branch that dies is evidence, never a silent skip
        journal = json.loads((Path(out) / 'autodrive.json').read_text()) if (
            Path(out) / 'autodrive.json').is_file() else dict(steps=[], status='error')
        error = dict(error=str(exc), traceback=traceback.format_exc())
    return dict(label=label, parent=parent, base=str(base_run), out=str(out),
                pages=list(pages), journal=journal, error=error,
                seconds=time.perf_counter() - started,
                metrics=branch_metrics(journal, inherited_pages, inherited_pieces))


def forced_plan(forced):
    """`PAGE=CLASS` reopenings named on the command line.

    A policy takes score classes in rank order, so reaching class three costs
    three branches. When a measurement has already established *which* class
    holds the better body - `placement_alternatives_oracle` reads the reference
    to do that - driving straight to it measures the ceiling of the policy for
    one branch instead of three. The result is a ceiling probe and the journal
    says so: a run that used this is not a policy result.
    """
    plan = []
    for entry in forced or ():
        site, _, index = str(entry).partition('=')
        plan.append((None if site == 'base' else int(site), int(index)))
    return plan


def run(pdf, allocation_run, base_run, pages, out, options, budget=1,
        triggers=('always',), order='base-first', alternatives_per_site=1,
        selection='downstream', capacity_audit=None, reuse_root=None, forced=()):
    """Drive, look for a contradiction, reopen a site, drive again - bounded.

    `reuse_root` adopts an already-completed run as branch 0 when its
    configuration matches, so a measurement does not pay for the baseline twice.
    Its journal is verified against this call's pages and option set before it is
    trusted; a mismatch is an error rather than a silent re-baseline.
    """
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    record = dict(pdf=str(pdf), allocation_run=str(allocation_run), base=str(base_run),
                  pages=list(pages), options=options, budget=budget, triggers=list(triggers),
                  order=order, alternatives_per_site=alternatives_per_site,
                  selection=selection, truth_used=False, runtime_vlm_calls=0, certified=False,
                  pdf_sha256=file_hash(pdf), branches=[], reopenings=[], status='running',
                  limitations=[
                      'A reopened site can only offer assemblies its own search retained',
                      'Branching takes one representative per exact objective-score class',
                      'A re-driven branch restarts camera and scale carry from its checkpoint '
                      'rather than inheriting the abandoned branch\'s in-flight state',
                      'Branch selection is runtime-legal and is not a certification'])
    journal_path = out / 'backtrack.json'
    autodrive.write_atomic(journal_path, json.dumps(record, indent=2))

    def publish():
        payload = dict(record, branches=[{k: v for k, v in entry.items() if k != 'journal'}
                                         for entry in record['branches']])
        autodrive.write_atomic(journal_path, json.dumps(payload, indent=2, default=str))

    if reuse_root:
        adopted = json.loads((Path(reuse_root) / 'autodrive.json').read_text())
        config = adopted.get('resume_config') or {}
        if list(config.get('pages') or []) != list(pages):
            raise ValueError('Adopted run drove a different page scope')
        # Compare as the journal stores them: an option built as a tuple is
        # written as a list, and a re-derived option set must not read as a
        # configuration change because of that round trip.
        stored = json.loads(json.dumps(options, default=str))
        recorded = config.get('options') or {}
        # An option added to the driver *after* a run cannot have changed that
        # run's behaviour as long as this call leaves it at its own documented
        # no-op default - `--compound-width 0` is the shipped behaviour, and
        # 41624's round-seven journal predates the flag existing. Reconciled
        # keys are recorded rather than silently accepted, and a key whose value
        # differs from the default is still a configuration change.
        defaults = json.loads(json.dumps(default_options(), default=str))
        reconciled = sorted(key for key in set(recorded) ^ set(stored)
                            if stored.get(key, defaults.get(key)) == defaults.get(key)
                            and recorded.get(key, defaults.get(key)) == defaults.get(key))
        differing = {key for key in set(recorded) | set(stored)
                     if key not in reconciled and recorded.get(key) != stored.get(key)}
        if differing:
            raise ValueError(f'Adopted run differs in options: {sorted(differing)}')
        record['adopted_option_keys_absent_at_their_default'] = reconciled
        if config.get('base_model_sha256') != file_hash(Path(base_run) / 'model.ldr'):
            raise ValueError('Adopted run started from a different checkpoint')
        root = dict(label='root', parent=None, base=str(base_run), out=str(reuse_root),
                    pages=list(pages), journal=adopted, error=None, seconds=None,
                    adopted=True, metrics=branch_metrics(adopted))
    else:
        root = drive(pdf, allocation_run, base_run, pages, out / 'branch-00', options, 'root')
        root['adopted'] = False
    root['index'] = 0
    record['branches'].append(root)
    publish()

    driven_digests = {}

    def mark(site, digest):
        driven_digests.setdefault(str(site), set()).add(digest)

    # The root's own body at every site it committed counts as driven: taking it
    # again would reproduce the root.
    for page, placement in reopen_sites(root, 'earliest'):
        if placement and (Path(placement) / 'results.json').is_file():
            census = score_classes(placement)
            first = census['classes'][0]['representative'] if census['classes'] else None
            if first:
                mark(placement, first['sha256'])
    base_census = score_classes(base_run) if (Path(base_run) / 'results.json').is_file() else None
    if base_census and base_census['classes']:
        mark(base_run, base_census['classes'][0]['representative']['sha256'])

    pending = [root]
    while len(record['branches']) - 1 < budget and pending:
        branch = pending.pop(0)
        verdict = assess(branch['journal'], triggers=tuple(t for t in triggers if t != 'always'),
                         capacity=capacity_audit)
        branch['assessment'] = verdict
        fired = bool(verdict['firings']) or 'always' in triggers
        if not fired:
            continue
        trigger_page = verdict['firings'][0]['page'] if verdict['firings'] else None
        sites = reopen_sites(branch, order)
        plan = forced_plan(forced) if branch['index'] == 0 else []
        if plan:
            # A ceiling probe: the named sites, in the order given, and no others.
            named = dict(sites)
            sites = [(page, named[page]) for page, _ in plan if page in named]
            record['probe'] = dict(
                forced=[[page, index] for page, index in plan],
                note='Score classes named from an evaluation-only measurement. This branch '
                     'measures the ceiling of the policy, not what the policy would select.')
        spent = 0
        for page, site in sites:
            if len(record['branches']) - 1 >= budget or spent >= alternatives_per_site:
                break
            if page is not None and trigger_page is not None and page >= trigger_page:
                # A page after the contradiction cannot have caused it, and the
                # page that *reported* it cannot have caused it either: every
                # trigger here is a statement about the body a page inherited -
                # a refused camera, a registration that fell off the drawings, a
                # pooled-inventory deficit - so the decision to revisit is always
                # strictly earlier than the page that raised it.
                continue
            if not (Path(site) / 'results.json').is_file():
                continue
            census, options_here = alternatives(site, driven_digests.get(str(site), ()))
            if plan:
                wanted = [index for named, index in plan if named == page]
                options_here = [entry for entry in options_here
                                if entry['score_class'] in wanted]
                if not options_here:
                    raise ValueError(f'Forced score class {wanted} is not offered at site {site}')
            for member in options_here:
                if len(record['branches']) - 1 >= budget or spent >= alternatives_per_site:
                    break
                index = len(record['branches'])
                label = f'reopen-{"base" if page is None else f"p{page:03d}"}-r{member["rank"]}'
                derived = derive_base(site, member,
                                      out / f'branch-{index:02d}-base',
                                      dict(parent_branch=branch['index'],
                                           parent_out=branch['out'],
                                           trigger=(verdict['firings'][0] if verdict['firings']
                                                    else dict(trigger='always')),
                                           site_page=page))
                forward = list(pages) if page is None else [p for p in pages if p > page]
                inherited_pages = 0 if page is None else sum(
                    1 for row in signals(branch['journal'])
                    if row['status'] == 'placed' and row['page'] <= page)
                inherited_pieces = 0
                if page is not None:
                    inherited_pieces = max(
                        [int((step.get('detail') or {}).get('selected_parts') or 0)
                         for step in branch['journal']['steps']
                         if step['page'] <= page] or [0])
                child = drive(pdf, allocation_run, derived, forward,
                              out / f'branch-{index:02d}', options, label,
                              parent=branch['index'], inherited_pages=inherited_pages,
                              inherited_pieces=inherited_pieces)
                child.update(index=index, reopened_page=page, reopened_site=str(site),
                             taken=dict(rank=member['rank'], file=member['file'],
                                        score=member['score'], score_class=member['score_class'],
                                        class_width=member['class_width'],
                                        sha256=member['sha256']),
                             site_census=dict(retained=census['retained'],
                                              distinct_bodies=census['distinct_bodies'],
                                              classes=[dict(score=entry['score'],
                                                            width=len(entry['members']),
                                                            distinct=entry['distinct_bodies'])
                                                       for entry in census['classes']]),
                             adopted=False)
                mark(site, member['sha256'])
                record['branches'].append(child)
                record['reopenings'].append(dict(branch=index, parent=branch['index'],
                                                 page=page, site=str(site), label=label,
                                                 trigger=(verdict['firings'][0]['trigger']
                                                          if verdict['firings'] else 'always'),
                                                 taken_rank=member['rank']))
                pending.append(child)
                spent += 1
                publish()
    chosen, ordering = select(record['branches'], selection)
    record['selected_branch'] = chosen['index']
    record['selection_order'] = ordering
    record['selected_checkpoint'] = chosen['metrics']['last_checkpoint']
    record['status'] = 'completed_uncertified'
    publish()
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--allocation-run', type=Path, required=True)
    parser.add_argument('--base-run', type=Path, required=True)
    parser.add_argument('--pages', type=int, nargs='+', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--backtrack-budget', type=int, default=1,
                        help='How many reopened branches this run may drive')
    parser.add_argument('--backtrack-triggers', nargs='+',
                        default=['registration_collapse', 'refusal_run'],
                        choices=['registration_collapse', 'refusal_run', 'score_trend',
                                 'capacity_violation', 'always'])
    parser.add_argument('--backtrack-order', default='base-first',
                        choices=['base-first', 'nearest', 'earliest'])
    parser.add_argument('--alternatives-per-site', type=int, default=1)
    parser.add_argument('--selection', default='downstream', choices=sorted(SELECTION_KEYS))
    parser.add_argument('--capacity-audit', type=Path,
                        help='A placement_capacity audit whose deficits may fire a reopening')
    parser.add_argument('--reuse-root', type=Path,
                        help='Adopt this completed run as branch 0 after verifying its config')
    parser.add_argument('--force-reopen', action='append', default=[], metavar='PAGE=CLASS',
                        help='Reopen exactly these sites at these score classes (PAGE may be '
                             '"base"). A ceiling probe, recorded as one: the class is chosen '
                             'from a measurement the policy itself cannot make.')
    autodrive.add_page_options(parser)
    args = parser.parse_args()
    options = autodrive.build_options(args)
    autodrive.apply_palette_options(options)
    record = run(args.pdf, args.allocation_run, args.base_run, args.pages, args.out, options,
                 budget=args.backtrack_budget, triggers=tuple(args.backtrack_triggers),
                 order=args.backtrack_order, alternatives_per_site=args.alternatives_per_site,
                 selection=args.selection,
                 capacity_audit=(json.loads(args.capacity_audit.read_text())
                                 if args.capacity_audit else None),
                 reuse_root=args.reuse_root, forced=args.force_reopen)
    print(json.dumps(dict(branches=[dict(index=entry['index'], label=entry['label'],
                                         metrics=entry['metrics'])
                                    for entry in record['branches']],
                          selected=record['selected_branch'],
                          order=record['selection_order']), indent=2, default=str))


if __name__ == '__main__':
    main()
