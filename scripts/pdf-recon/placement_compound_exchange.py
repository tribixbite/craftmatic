"""Two-placement exchanges: the moves a one-at-a-time exchange cannot make.

Round seven measured twenty-one distinct reference instances that are enumerated,
screened, and in no assembly the run wrote, and separated the mechanisms. Two of
those classes are not ranking failures at all - they are **structural**, and no
window ordering, beam width or budget reaches them, because the only legal
assembly containing the target differs from the selected one in *two* placements:

* **closure-parent connectivity** - 5 of the 21. The target is a closure pose one
  hop from an anchor, and every one of its one-swap probes fails on connectivity,
  never on collision (0 collide, 11 disconnect). A closure pose is legal only
  together with the placement that witnesses its support, so admitting it alone
  disconnects the assembly by construction. 40377 truth index 75 on page 26, and
  41624 truth indices 29, 30, 87 and 97.
* **collision** - 2 of the 21. The reference pose collides with the piece already
  standing in its place, so it can only enter if that piece leaves in the same
  move. 40377 truth index 53 on page 19 - the rank-0 single placement on the
  whole page - and truth index 78 on page 28.

The exact per-key cardinality is what makes this precise rather than a heuristic:
a quota-preserving edit must remove exactly as many placements of each key as it
adds, so a two-placement exchange is the *next* minimal legal edit after the
one-swap, and there is a finite guided set of them.

Every function here is pure: index arithmetic over a placement bank, a witnessed
support adjacency, a collision predicate and a ranking statistic. No GPU, no PDF,
no reference model - the reference model named the instances above afterwards and
selects nothing at runtime. `placement_multi_shape_search.native_exchange` and
`placement_retention_stage`'s probe both call these, so the diagnostic and the
production move are the same code by construction.
"""
import numpy as np


def key_pair(keys, first, second):
    """The unordered key multiset of two placements, comparable across pairs."""
    return tuple(sorted((repr(keys[int(first)]), repr(keys[int(second)]))))


def double_swap_sets(selected, incoming, partner, keys):
    """Every quota-preserving assembly that removes two members and adds these two.

    `swap_sets` is the minimal legal edit under an exact per-key quota: a target
    can only enter by displacing a placement of its own key. This is the next one
    up. The two incoming placements must between them carry the same key multiset
    as the two displaced ones, or the assembly no longer satisfies the page's
    allocation - which is why a target and a partner of the *same* key need two
    members of that key in the assembly, and get nothing when the quota is one.
    """
    selected = [int(i) for i in selected]
    incoming, partner = int(incoming), int(partner)
    if incoming == partner or incoming in selected or partner in selected:
        return []
    wanted = key_pair(keys, incoming, partner)
    out = set()
    for i in range(len(selected)):
        for j in range(i + 1, len(selected)):
            if key_pair(keys, selected[i], selected[j]) != wanted:
                continue
            rest = [selected[k] for k in range(len(selected)) if k not in (i, j)]
            out.add(tuple(sorted(rest + [incoming, partner])))
    return sorted(out)


def rank_options(options, statistic, tie_ranks=None):
    """Deterministic best-first order over partner options.

    Ties resolve by `tie_ranks` when the run supplies them, so a compound move
    is chosen by the same rule as every other tied decision in the chain rather
    than by bank index (which is closure enumeration order, which re-rolls
    whenever an unrelated setting changes the bank).
    """
    statistic = np.asarray(statistic, float)
    if tie_ranks is None:
        return sorted((int(o) for o in options), key=lambda o: (-statistic[o], o))
    tie_ranks = np.asarray(tie_ranks)
    return sorted((int(o) for o in options),
                  key=lambda o: (-statistic[o], int(tie_ranks[o]), o))


def connectivity_partners(incoming, rest, adjacency, statistic, limit, tie_ranks=None):
    """Witnessed support neighbours of `incoming` that are not already placed.

    A target whose every one-swap probe fails on connectivity is not weakly
    ranked - it is structurally illegal on its own. What makes it legal is the
    placement that witnesses its support, so the partner set is exactly that
    neighbourhood: no search over the whole bank, and no relaxation of the
    connectivity rule itself. The physical claim the assembly makes is unchanged;
    only the size of one edit is.
    """
    incoming = int(incoming)
    placed = {int(i) for i in rest} | {incoming}
    options = [int(p) for p in adjacency[incoming] if int(p) not in placed]
    return rank_options(options, statistic, tie_ranks)[:max(0, int(limit))]


def collision_partners(incoming, rest, keys, conflict, statistic, limit, tie_ranks=None):
    """Replacements for the already-placed members `incoming` collides with.

    Returns `(partners, blockers)`. A partner must carry a blocker's key - that
    is what keeps the quota - and must not itself collide with `incoming`, or the
    compound move is no better than the single one. The predicate is tested
    lazily down the ranked order and stops at `limit`, because it is a voxel
    intersection and the same-key candidate set runs to thousands.
    """
    incoming = int(incoming)
    rest = [int(i) for i in rest]
    blockers = [i for i in rest if conflict(incoming, i)]
    if not blockers:
        return [], []
    blocked = {repr(keys[i]) for i in blockers}
    placed = set(rest) | {incoming}
    options = [i for i in range(len(keys))
               if repr(keys[i]) in blocked and i not in placed]
    partners = []
    for option in rank_options(options, statistic, tie_ranks):
        if conflict(incoming, option):
            continue
        partners.append(option)
        if len(partners) >= max(0, int(limit)):
            break
    return partners, blockers


def ordered_replacement(chosen, group, keys):
    """Rewrite `chosen` in place-order so a compound move keeps the slot layout.

    The exchange iterates slots by position and resolves an exact tie between two
    improvements by which slot it visited first, so replacing the assembly with a
    re-sorted list would change the resolution of ties that have nothing to do
    with the move. Each displaced slot receives the incoming placement carrying
    the same key, which is well defined precisely because the move is
    quota-preserving.
    """
    chosen = [int(i) for i in chosen]
    group = [int(i) for i in group]
    incoming = [i for i in group if i not in chosen]
    out = list(chosen)
    for position, index in enumerate(chosen):
        if index in group:
            continue
        match = next((i for i in incoming if repr(keys[i]) == repr(keys[index])), None)
        if match is None:
            raise ValueError('Compound replacement is not quota-preserving')
        incoming.remove(match)
        out[position] = match
    if incoming:
        raise ValueError('Compound replacement leaves an incoming placement unplaced')
    return out


def legal(group, keys, quotas, conflict, connected):
    """Is this index set a legal complete assembly - quota, collision and support?

    Checked in full rather than incrementally, because a compound move changes
    two members at once and an incremental argument about which pairs are new is
    exactly the kind of reasoning that hides a defect.
    """
    group = tuple(sorted(int(i) for i in group))
    counts = {}
    for index in group:
        counts[repr(keys[index])] = counts.get(repr(keys[index]), 0) + 1
    if quotas is not None and counts != {repr(k): int(v) for k, v in quotas.items()}:
        return False, 'quota'
    for position, first in enumerate(group):
        for second in group[position + 1:]:
            if conflict(first, second):
                return False, 'collision'
    if not connected(group):
        return False, 'connectivity'
    return True, 'legal'


def compound_assemblies(chosen, incoming, keys, adjacency, conflict, connected, statistic,
                        width, mode='both', quotas=None, tie_ranks=None):
    """Bounded, guided, legal two-placement exchanges that admit `incoming`.

    Called only for a candidate a one-swap has already *rejected*, so the cost is
    paid exactly where the single move is known to be structurally blocked. Two
    generators, matched to the two measured classes: the witnessed parent for a
    connectivity rejection, the blocker's replacement for a collision one. Both
    are capped at `width` partners.

    Returns `(assemblies, report)`. The report carries the partner counts and the
    rejection reasons of the sets that were enumerated but not legal, so a zero
    is a measured zero rather than an absence of evidence.
    """
    if mode not in ('connectivity', 'collision', 'both'):
        raise ValueError('Unknown compound exchange mode')
    chosen = [int(i) for i in chosen]
    incoming = int(incoming)
    rest_for_partners = [i for i in chosen if i != incoming]
    partners, blockers = [], []
    if mode in ('collision', 'both'):
        partners, blockers = collision_partners(incoming, rest_for_partners, keys, conflict,
                                                statistic, width, tie_ranks)
    connectivity = []
    if mode in ('connectivity', 'both'):
        connectivity = connectivity_partners(incoming, rest_for_partners, adjacency, statistic,
                                             width, tie_ranks)
    ordered, seen = [], set()
    for partner in list(connectivity) + list(partners):
        if partner not in seen:
            seen.add(partner)
            ordered.append(partner)
    assemblies, rejected = [], {}
    for partner in ordered:
        for group in double_swap_sets(chosen, incoming, partner, keys):
            ok, reason = legal(group, keys, quotas, conflict, connected)
            if ok:
                assemblies.append(group)
            else:
                rejected[reason] = rejected.get(reason, 0) + 1
    unique, out = set(), []
    for group in assemblies:
        if group not in unique:
            unique.add(group)
            out.append(group)
    return out, dict(mode=mode, width=int(width), incoming=incoming,
                     connectivity_partners=[int(p) for p in connectivity],
                     collision_partners=[int(p) for p in partners],
                     blockers=[int(b) for b in blockers],
                     enumerated=len(assemblies) + sum(rejected.values()),
                     legal=len(out), rejected=rejected)
