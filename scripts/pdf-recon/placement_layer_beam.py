"""Beam search over registered CAD depth/material layers for one page step.

The exact-cardinality depth-first search does not scale past about three
additions: on a six-bracket page with 1,382 registered placements it spent its
whole node budget without reaching a single complete assembly. This module
replaces the traversal, not the evidence.

Structure of the search:

* States are sets, expanded one placement at a time. A placement may be added
  only if it is base-anchored or adjacent, in the witnessed support graph, to
  something already chosen. Every connected set containing an anchor has such
  an insertion order, so this rule loses no structurally legal set.
* Ranking during expansion uses an occlusion-free union approximation of the
  per-class intersection-over-union, computed on sparse per-candidate pixel
  index segments. It is optimistic about correct pixels and pessimistic about
  hidden false positives.
* Only complete states are scored exactly, with the real depth composite, and
  only those survivors are handed to native rendering. Nothing is selected
  from an incomplete-assembly image score.

The beam width is an explicit incompleteness: a correct assembly whose partial
prefixes all rank below the width is lost. That is recorded, never hidden.
No reference model, set inventory or VLM participates.
"""
from collections import Counter
import numpy as np


def _segments(masks, classes, target, labels_of):
    """Sparse per-(candidate, class) pixel indices for correct and false pixels."""
    correct, false = [], []
    for index in range(len(masks)):
        layer = labels_of(index)
        for class_index, value in enumerate(classes):
            painted = layer == value
            correct.append(np.flatnonzero(painted & (target == value)))
            false.append(np.flatnonzero(painted & (target != value)))
    return correct, false


def _flatten(segments):
    lengths = np.array([len(s) for s in segments], np.int64)
    offsets = np.zeros(len(segments), np.int64)
    np.cumsum(lengths[:-1], out=offsets[1:])
    flat = np.concatenate(segments) if len(segments) else np.zeros(0, np.int64)
    return flat, offsets, lengths


def _gains(flat, offsets, lengths, covered):
    """Per-segment count of indices not already covered by the state.

    A prefix-sum difference is used rather than `add.reduceat`, which cannot
    represent an empty trailing segment: candidates that paint no pixel of a
    class are ordinary here, not an error.
    """
    if len(flat) == 0:
        return np.zeros(len(offsets), np.int64)
    running = np.zeros(len(flat) + 1, np.int64)
    np.cumsum(~covered[flat], out=running[1:])
    return running[offsets + lengths] - running[offsets]


def search_beam(base_depth, base_labels, depths, labels, keys, quotas, target,
                base_supported=(), support_edges=(), conflict_test=None,
                beam=64, top_k=16, max_expansions=2_000_000,
                improve_rounds=8, improve_from=4):
    """Return the highest exactly-scored complete assemblies found by the beam."""
    depths = np.asarray(depths)
    labels = np.asarray(labels)
    target = np.asarray(target)
    base_labels = np.asarray(base_labels)
    base_depth = np.asarray(base_depth)
    n = len(labels)
    keys = list(keys)
    quotas = dict(quotas)
    if len(keys) != n:
        raise ValueError('One quota key per candidate layer is required')
    if any(k not in quotas for k in keys):
        raise ValueError('Candidate key missing from the quota')
    if beam < 1 or top_k < 1:
        raise ValueError('Beam width and retained count must be positive')
    if labels.shape != depths.shape or labels.shape[1:] != target.shape:
        raise ValueError('Layer dimensions mismatch')
    classes = [int(v) for v in np.unique(target) if v > 0]
    if not classes:
        raise ValueError('Target has no scored material classes')
    total = sum(quotas.values())
    if total < 1:
        raise ValueError('Empty quota')

    flat_target = target.reshape(-1)
    areas = np.array([int(np.sum(flat_target == c)) for c in classes], np.int64)
    flat_base = base_labels.reshape(-1)
    pixels = flat_target.size
    class_count = len(classes)
    # The existing body's own correct and false pixels are pre-marked as covered
    # so that a candidate painting over them is not credited a second time.
    seed_correct = np.zeros(class_count * pixels, bool)
    seed_false = np.zeros(class_count * pixels, bool)
    for class_index, value in enumerate(classes):
        painted = flat_base == value
        window = slice(class_index * pixels, (class_index + 1) * pixels)
        seed_correct[window] = painted & (flat_target == value)
        seed_false[window] = painted & (flat_target != value)
    correct_segments, false_segments = _segments(
        labels, classes, flat_target, lambda i: labels[i].reshape(-1))
    correct_flat, correct_offsets, correct_lengths = _flatten(correct_segments)
    false_flat, false_offsets, false_lengths = _flatten(false_segments)

    def totals(covered):
        return np.array([int(np.sum(covered[c * pixels:(c + 1) * pixels]))
                         for c in range(class_count)], np.int64)

    anchored = set(int(i) for i in base_supported)
    adjacency = [set() for _ in range(n)]
    for a, b in support_edges:
        if not 0 <= a < n or not 0 <= b < n or a == b:
            raise ValueError('Support edge outside the candidate bank or self edge')
        adjacency[a].add(b)
        adjacency[b].add(a)

    def approximate(correct_counts, false_counts):
        return float(np.mean(correct_counts / np.maximum(1, areas + false_counts)))

    start = dict(chosen=(), counts=Counter(), covered_correct=seed_correct,
                 covered_false=seed_false, correct=totals(seed_correct),
                 false=totals(seed_false), frontier=set(anchored))
    states = [start]
    expansions = 0
    budget_hit = False
    for _ in range(total):
        nominees = []
        for state in states:
            available = np.zeros(n, bool)
            candidates = state['frontier'] if state['chosen'] else anchored
            for index in candidates:
                if state['counts'][keys[index]] < quotas[keys[index]]:
                    available[index] = True
            if not available.any():
                continue
            gain_correct = _gains(correct_flat, correct_offsets, correct_lengths,
                                  state['covered_correct']).reshape(n, class_count)
            gain_false = _gains(false_flat, false_offsets, false_lengths,
                                state['covered_false']).reshape(n, class_count)
            scores = np.mean((state['correct'] + gain_correct)
                             / np.maximum(1, areas + state['false'] + gain_false), axis=1)
            scores[~available] = -1.
            order = np.argsort(-scores, kind='stable')
            taken = 0
            for index in order:
                if scores[index] < 0 or taken >= beam:
                    break
                expansions += 1
                if expansions > max_expansions:
                    budget_hit = True
                    break
                if conflict_test is not None and any(conflict_test(int(index), j)
                                                     for j in state['chosen']):
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
            covered_correct = state['covered_correct'].copy()
            covered_false = state['covered_false'].copy()
            for class_index in range(class_count):
                segment = index * class_count + class_index
                covered_correct[correct_flat[correct_offsets[segment]:
                                             correct_offsets[segment] + correct_lengths[segment]]] = True
                covered_false[false_flat[false_offsets[segment]:
                                         false_offsets[segment] + false_lengths[segment]]] = True
            counts = state['counts'].copy()
            counts[keys[index]] += 1
            correct = totals(covered_correct)
            false = totals(covered_false)
            fresh.append(dict(chosen=chosen, counts=counts, covered_correct=covered_correct,
                              covered_false=covered_false, correct=correct, false=false,
                              frontier=(state['frontier'] | adjacency[index] | anchored) - set(chosen),
                              approximate=approximate(correct, false)))
            if len(fresh) >= beam:
                break
        states = fresh
        if budget_hit:
            break

    def connected(chosen):
        wanted = set(chosen)
        seen = wanted & anchored
        todo = list(seen)
        while todo:
            new = (adjacency[todo.pop()] & wanted) - seen
            seen.update(new)
            todo.extend(new)
        return seen == wanted

    def exact(chosen):
        depth = base_depth.copy()
        label = base_labels.copy()
        for index in sorted(chosen):
            take = np.isfinite(depths[index]) & (depths[index] >= depth)
            depth[take] = depths[index][take]
            label[take] = labels[index][take]
        return float(np.mean([np.sum((target == c) & (label == c))
                              / max(1, np.sum((target == c) | (label == c))) for c in classes]))

    def composite_of(chosen):
        depth = base_depth.copy()
        label = base_labels.copy()
        for index in sorted(chosen):
            take = np.isfinite(depths[index]) & (depths[index] >= depth)
            depth[take] = depths[index][take]
            label[take] = labels[index][take]
        return depth, label

    def metric_of(label):
        return float(np.mean([np.sum((target == c) & (label == c))
                              / max(1, np.sum((target == c) | (label == c))) for c in classes]))

    def legal(chosen, index):
        if conflict_test is not None and any(conflict_test(index, other) for other in chosen):
            return False
        return connected(tuple(chosen) + (index,))

    def improve(chosen, score, rounds):
        """Greedy single-placement exchange on the exact depth composite.

        The beam commits to early additions before the later ones are known;
        an exchange pass can leave that local optimum. Only quota-preserving
        exchanges are considered, so the assembly stays exactly allocated.
        """
        chosen = list(chosen)
        swaps = 0
        for _ in range(rounds):
            best = None
            for position, outgoing in enumerate(chosen):
                rest = chosen[:position] + chosen[position + 1:]
                partial_depth, partial_label = composite_of(rest)
                for incoming in range(n):
                    if incoming in chosen or keys[incoming] != keys[outgoing]:
                        continue
                    if not legal(rest, incoming):
                        continue
                    take = np.isfinite(depths[incoming]) & (depths[incoming] >= partial_depth)
                    label = np.where(take, labels[incoming], partial_label)
                    value = metric_of(label)
                    if value > score + 1e-12 and (best is None or value > best[0]):
                        best = (value, position, incoming)
            if best is None:
                break
            score, position, incoming = best
            chosen[position] = incoming
            swaps += 1
        return tuple(sorted(chosen)), score, swaps

    retained = []
    for state in states:
        if any(state['counts'][k] != q for k, q in quotas.items()):
            continue
        if not connected(state['chosen']):
            continue
        retained.append(dict(indices=tuple(state['chosen']), score=exact(state['chosen']),
                             approximate_score=state['approximate']))
    retained.sort(key=lambda row: (-row['score'], row['indices']))
    del retained[top_k:]
    improved, total_swaps = [], 0
    sources = retained[:max(0, improve_from)] if improve_rounds > 0 else []
    for row in sources:
        indices, score, swaps = improve(row['indices'], row['score'], improve_rounds)
        total_swaps += swaps
        if swaps:
            improved.append(dict(indices=indices, score=score,
                                 approximate_score=row['approximate_score'],
                                 improved_from=list(row['indices']), exchanges=swaps))
    unique, seen_keys = [], set()
    for row in sorted(improved + retained, key=lambda r: (-r['score'], r['indices'])):
        if row['indices'] in seen_keys:
            continue
        seen_keys.add(row['indices'])
        unique.append(row)
    del unique[top_k:]
    return dict(indices=unique[0]['indices'] if unique else None,
                score=unique[0]['score'] if unique else None,
                candidates=unique, top_k=top_k, beam=beam, expansions=expansions,
                expansion_budget=max_expansions, budget_hit=budget_hit,
                complete_states=len(retained), final_states=len(states),
                improved_states=len(improved), exchanges=total_swaps,
                improve_rounds=improve_rounds, improve_from=improve_from,
                search_exhaustive=False, truth_used=False, certified=False,
                method='Support-frontier beam over registered layers; occlusion-free union '
                       'ranking during expansion; exact depth-composite score for complete '
                       'states; quota-preserving single-placement exchange improvement',
                limitations='Beam width is an explicit incompleteness: an assembly whose partial '
                            'prefixes all rank below the width is never reached. Union ranking '
                            'ignores mutual occlusion between additions. Exchange improvement is '
                            'a local optimum of the coarse composite, not a global optimum. '
                            'Optimality is not claimed inside or outside the registered layer '
                            'representation.')
