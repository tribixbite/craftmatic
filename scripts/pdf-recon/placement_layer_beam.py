"""Beam and exchange search over registered CAD depth/material layers.

The exact-cardinality depth-first search does not scale past about three
additions: on a six-bracket page with 1,382 registered placements it spent its
whole node budget without reaching a single complete assembly. This module
replaces the traversal, not the evidence.

Structure of the search:

* States are sets, expanded one placement at a time. A placement may be added
  only if it is base-anchored or adjacent, in the witnessed support graph, to
  something already chosen. Every connected set containing an anchor has such
  an insertion order, so this rule loses no structurally legal set.
* Both expansion and improvement rank by the *exact* per-class
  intersection-over-union of the real depth composite. Each candidate paints
  few pixels, so its effect on the composite is evaluated incrementally on
  sparse per-candidate index segments rather than by rebuilding the canvas.
  There is no occlusion-free approximation anywhere in the ranking.
* A quota-preserving exchange pass, restarted from several beam states and
  optionally perturbed, leaves the local optimum that greedy expansion commits
  to. Diagnostics on two 40377 pages showed the reference-equivalent assembly
  outscoring the selected one under the runtime scorer: the failure being
  attacked here is search, not evidence.

Beam width, exchange rounds and restarts are explicit incompleteness. Nothing
here is a global optimum, and no reference model, set inventory or VLM
participates.
"""
from collections import Counter
import numpy as np


class LayerComposite:
    """Exact depth-composite scoring with sparse per-candidate updates."""

    def __init__(self, base_depth, base_labels, depths, labels, target):
        self.base_depth = np.asarray(base_depth)
        self.base_labels = np.asarray(base_labels)
        self.depths = np.asarray(depths)
        self.labels = np.asarray(labels)
        self.target = np.asarray(target)
        self.classes = [int(v) for v in np.unique(self.target) if v > 0]
        if not self.classes:
            raise ValueError('Target has no scored material classes')
        flat_target = self.target.reshape(-1)
        self.flat_target = flat_target
        self.areas = np.array([int(np.sum(flat_target == c)) for c in self.classes], np.int64)
        pieces, lengths = [], []
        for index in range(len(self.labels)):
            painted = np.flatnonzero(np.isfinite(self.depths[index]).reshape(-1))
            pieces.append(painted)
            lengths.append(len(painted))
        self.pix = np.concatenate(pieces) if pieces else np.zeros(0, np.int64)
        self.lengths = np.asarray(lengths, np.int64)
        self.offsets = np.zeros(len(lengths), np.int64)
        np.cumsum(self.lengths[:-1], out=self.offsets[1:])
        self.lab = np.concatenate([self.labels[i].reshape(-1)[p]
                                   for i, p in enumerate(pieces)]) if pieces else np.zeros(0, np.uint8)
        self.dep = np.concatenate([self.depths[i].reshape(-1)[p]
                                   for i, p in enumerate(pieces)]) if pieces else np.zeros(0)
        self.tgt = flat_target[self.pix] if self.pix.size else np.zeros(0, np.uint8)
        # Segment id per painted pixel and a class value -> column map, so a
        # delta is four filtered bincounts over (segment, class) cells rather
        # than a separate pass per class.
        self.seg = np.repeat(np.arange(len(self.lengths)), self.lengths)
        self.column = np.full(256, -1, np.int64)
        for column, value in enumerate(self.classes):
            self.column[value] = column
        self.target_column = self.column[self.tgt] if self.tgt.size else np.zeros(0, np.int64)
        self.cells = len(self.lengths) * len(self.classes)
        self.base_cell = self.seg * len(self.classes)
        self._own = None

    def own_agreement(self):
        """Per candidate: its own painted pixels that already carry the drawing's class.

        The incremental ranking everything else uses asks what a candidate adds
        to the composite, which is zero whenever those pixels are already
        painted with the same class - *including by a wrong piece standing in
        the same place*, so a white plate on a white body is invisible to it.
        Measured on 40377 page 19 view 1, 1,236 of 2,637 screened candidates
        (46.9%) change the incremental score by exactly zero, bit for bit, and
        `argsort(kind='stable')` then orders that plateau by bank index - which
        is enumeration order, not evidence. The plateau is 5.9% to 52.6% of the
        screened set across all 40 driven pages of the two fixtures.

        This statistic cannot be flattened by anything already placed, because
        it never consults the composite. It is occlusion-free by construction -
        it counts the candidate's painted pixels whether or not they would win
        the depth test - which is exactly what makes it independent, and also
        its limitation: it cannot tell a visible pose from a buried one. One
        bincount over the sparse segments already built here, so no render.
        """
        if self._own is None:
            if self.pix.size == 0:
                self._own = np.zeros(len(self.lengths), np.int64)
            else:
                hit = (self.lab == self.tgt) & (self.tgt > 0)
                self._own = np.bincount(self.seg[hit],
                                        minlength=len(self.lengths)).astype(np.int64)
        return self._own

    def composite(self, chosen):
        depth = self.base_depth.copy()
        label = self.base_labels.copy()
        for index in sorted(chosen):
            take = np.isfinite(self.depths[index]) & (self.depths[index] >= depth)
            depth[take] = self.depths[index][take]
            label[take] = self.labels[index][take]
        return depth, label

    def counts(self, label):
        flat = label.reshape(-1)
        correct = np.array([int(np.sum((flat == c) & (self.flat_target == c)))
                            for c in self.classes], np.int64)
        false = np.array([int(np.sum((flat == c) & (self.flat_target != c)))
                          for c in self.classes], np.int64)
        return correct, false

    def metric(self, correct, false):
        return float(np.mean(correct / np.maximum(1, self.areas + false)))

    def score(self, chosen):
        return self.metric(*self.counts(self.composite(chosen)[1]))

    def deltas(self, depth, label):
        """Per-candidate change in correct and false counts if added to (depth, label).

        Evaluated on the candidate's own painted pixels only, which is exact:
        a candidate cannot change a pixel it does not paint, and the winner at
        a painted pixel is decided by the same depth comparison the composite
        uses.
        """
        n = len(self.lengths)
        if self.pix.size == 0:
            zero = np.zeros((n, len(self.classes)), np.int64)
            return zero, zero
        flat_depth = depth.reshape(-1)
        flat_label = label.reshape(-1)
        take = self.dep >= flat_depth[self.pix]
        old = np.where(take, flat_label[self.pix], 0)
        new = np.where(take, self.lab, 0)
        columns = len(self.classes)
        new_column = self.column[new]
        old_column = self.column[old]
        correct = np.zeros(self.cells, np.int64)
        false = np.zeros(self.cells, np.int64)
        for column_of, sign in ((new_column, 1), (old_column, -1)):
            scored = column_of >= 0
            hit = scored & (column_of == self.target_column)
            miss = scored & ~hit
            cell = self.base_cell + column_of
            correct += sign * np.bincount(cell[hit], minlength=self.cells)
            false += sign * np.bincount(cell[miss], minlength=self.cells)
        return correct.reshape(n, columns), false.reshape(n, columns)


def search_beam(base_depth, base_labels, depths, labels, keys, quotas, target,
                base_supported=(), support_edges=(), conflict_test=None,
                beam=64, top_k=16, max_expansions=2_000_000,
                improve_rounds=8, improve_from=4, restarts=0, perturb=2, seed=0):
    """Return the highest exactly-scored complete assemblies found."""
    depths = np.asarray(depths)
    labels = np.asarray(labels)
    n = len(labels)
    keys = list(keys)
    quotas = dict(quotas)
    if len(keys) != n:
        raise ValueError('One quota key per candidate layer is required')
    if any(k not in quotas for k in keys):
        raise ValueError('Candidate key missing from the quota')
    if beam < 1 or top_k < 1:
        raise ValueError('Beam width and retained count must be positive')
    if labels.shape != depths.shape or labels.shape[1:] != np.asarray(target).shape:
        raise ValueError('Layer dimensions mismatch')
    total = sum(quotas.values())
    if total < 1:
        raise ValueError('Empty quota')
    model = LayerComposite(base_depth, base_labels, depths, labels, target)

    anchored = set(int(i) for i in base_supported)
    adjacency = [set() for _ in range(n)]
    for a, b in support_edges:
        if not 0 <= a < n or not 0 <= b < n or a == b:
            raise ValueError('Support edge outside the candidate bank or self edge')
        adjacency[a].add(b)
        adjacency[b].add(a)

    def connected(chosen):
        wanted = set(chosen)
        seen = wanted & anchored
        todo = list(seen)
        while todo:
            new = (adjacency[todo.pop()] & wanted) - seen
            seen.update(new)
            todo.extend(new)
        return seen == wanted

    def conflicts_with(index, chosen):
        return conflict_test is not None and any(conflict_test(index, other) for other in chosen)

    def rank(chosen, allowed):
        """Exact score of each allowed addition to `chosen`, -inf elsewhere."""
        depth, label = model.composite(chosen)
        correct, false = model.counts(label)
        dc, df = model.deltas(depth, label)
        scores = np.mean((correct + dc) / np.maximum(1, model.areas + false + df), axis=1)
        scores[~allowed] = -np.inf
        return scores

    start = dict(chosen=(), counts=Counter(), frontier=set(anchored))
    states = [start]
    expansions = 0
    budget_hit = False
    for _ in range(total):
        nominees = []
        for state in states:
            allowed = np.zeros(n, bool)
            for index in (state['frontier'] if state['chosen'] else anchored):
                if state['counts'][keys[index]] < quotas[keys[index]]:
                    allowed[index] = True
            if not allowed.any():
                continue
            scores = rank(state['chosen'], allowed)
            taken = 0
            for index in np.argsort(-scores, kind='stable'):
                if not np.isfinite(scores[index]) or taken >= beam:
                    break
                expansions += 1
                if expansions > max_expansions:
                    budget_hit = True
                    break
                if conflicts_with(int(index), state['chosen']):
                    continue
                nominees.append((float(scores[index]), state, int(index)))
                taken += 1
            if budget_hit:
                break
        if not nominees:
            states = []
            break
        nominees.sort(key=lambda row: -row[0])
        fresh, seen = [], set()
        for score, state, index in nominees:
            chosen = tuple(sorted(state['chosen'] + (index,)))
            if chosen in seen:
                continue
            seen.add(chosen)
            counts = state['counts'].copy()
            counts[keys[index]] += 1
            fresh.append(dict(chosen=chosen, counts=counts, score=score,
                              frontier=(state['frontier'] | adjacency[index] | anchored) - set(chosen)))
            if len(fresh) >= beam:
                break
        states = fresh
        if budget_hit:
            break

    def complete(chosen):
        counts = Counter(keys[i] for i in chosen)
        return all(counts[k] == q for k, q in quotas.items()) and connected(chosen)

    def exchange(chosen, rounds):
        """Steepest-descent quota-preserving single-placement exchange."""
        chosen = list(chosen)
        score = model.score(chosen)
        swaps = 0
        for _ in range(rounds):
            best = None
            for position, outgoing in enumerate(chosen):
                rest = chosen[:position] + chosen[position + 1:]
                depth, label = model.composite(rest)
                correct, false = model.counts(label)
                dc, df = model.deltas(depth, label)
                scores = np.mean((correct + dc) / np.maximum(1, model.areas + false + df), axis=1)
                same_key = np.array([keys[i] == keys[outgoing] for i in range(n)])
                scores = np.where(same_key, scores, -np.inf)
                scores[list(chosen)] = -np.inf
                for index in np.argsort(-scores, kind='stable')[:64]:
                    value = float(scores[index])
                    if not np.isfinite(value) or value <= score + 1e-12:
                        break
                    if best is not None and value <= best[0]:
                        break
                    if conflicts_with(int(index), rest) or not connected(rest + [int(index)]):
                        continue
                    best = (value, position, int(index))
                    break
            if best is None:
                break
            score, position, incoming = best
            chosen[position] = incoming
            swaps += 1
        return tuple(sorted(chosen)), score, swaps

    retained = [dict(indices=tuple(s['chosen']), score=model.score(s['chosen']))
                for s in states if complete(s['chosen'])]
    retained.sort(key=lambda row: (-row['score'], row['indices']))
    del retained[top_k:]

    found, exchanges = {row['indices']: row for row in retained}, 0
    if improve_rounds > 0:
        generator = np.random.default_rng(seed)
        for row in retained[:max(0, improve_from)]:
            indices, score, swaps = exchange(row['indices'], improve_rounds)
            exchanges += swaps
            if complete(indices):
                found.setdefault(indices, dict(indices=indices, score=score,
                                               improved_from=list(row['indices']),
                                               exchanges=swaps))
            current = indices
            for _ in range(max(0, restarts)):
                # Iterated local search: displace part of the solution, then let
                # the exchange pass re-optimise from there.
                trial = list(current)
                for position in generator.choice(len(trial), size=min(perturb, len(trial)),
                                                 replace=False):
                    outgoing = trial[position]
                    options = [i for i in range(n) if keys[i] == keys[outgoing]
                               and i not in trial]
                    if not options:
                        continue
                    pick = int(generator.choice(options))
                    rest = [v for k, v in enumerate(trial) if k != position]
                    if conflicts_with(pick, rest) or not connected(rest + [pick]):
                        continue
                    trial[position] = pick
                if not complete(tuple(sorted(trial))):
                    continue
                indices, score, swaps = exchange(tuple(sorted(trial)), improve_rounds)
                exchanges += swaps
                if complete(indices) and indices not in found:
                    found[indices] = dict(indices=indices, score=score,
                                          improved_from=list(current), exchanges=swaps,
                                          restart=True)
                if indices in found and found[indices]['score'] > model.score(current):
                    current = indices

    unique = sorted(found.values(), key=lambda row: (-row['score'], row['indices']))[:top_k]
    return dict(indices=unique[0]['indices'] if unique else None,
                score=unique[0]['score'] if unique else None,
                candidates=unique, top_k=top_k, beam=beam, expansions=expansions,
                expansion_budget=max_expansions, budget_hit=budget_hit,
                complete_states=len(retained), final_states=len(states),
                improved_states=sum(1 for row in unique if 'improved_from' in row),
                exchanges=exchanges, improve_rounds=improve_rounds, improve_from=improve_from,
                restarts=restarts, perturb=perturb,
                search_exhaustive=False, truth_used=False, certified=False,
                method='Support-frontier beam over registered layers ranked by the exact depth '
                       'composite through sparse per-candidate deltas, then quota-preserving '
                       'exchange with optional perturbed restarts',
                limitations='Beam width, exchange rounds and restart count are explicit '
                            'incompleteness: an assembly whose partial prefixes all rank below the '
                            'width and which no exchange path reaches is never found. Optimality '
                            'is not claimed inside or outside the registered layer representation.')
