"""Evaluation-only: are a page's allocated pieces one rigid group at all?

`placement_construct_body` builds every allocated piece of a subassembly page
into one connected body. That is only possible if the pieces *are* one connected
body, and on 40377 page index 20 they are not: its parts strip lists seven
pieces, five of which form the beak and two of which are black round tiles the
booklet installs on the head during the attachment on page 21.

This measures that directly, with the exact predicate `Assembly._consume_
coincident` uses, over the reference poses of the pieces. It reads the
independent model and therefore selects nothing at runtime - it exists to say
whether a construction failure is a search failure or a well-posedness failure,
because those need different fixes and look identical in the output.

The pieces are located in the reference by (part, colour) within a stated radius
of a stated centre, so a set that appears several times in a model is not
silently mixed. Both are arguments, and the record carries them.
"""
import argparse
import json
import sys
from itertools import combinations
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def components(items):
    """Connected components of `items` under the connector-mate predicate."""
    from placement_seated_contact import engaged_mates
    parent = list(range(len(items)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    edges = []
    for i, j in combinations(range(len(items)), 2):
        engaged = engaged_mates([items[j]], [items[i]])['engaged']
        if engaged:
            edges.append(dict(a=i, b=j, engaged=int(engaged)))
            parent[find(i)] = find(j)
    groups = {}
    for index in range(len(items)):
        groups.setdefault(find(index), []).append(index)
    return sorted(groups.values(), key=len, reverse=True), edges


def locate(truth, pieces, centre, radius):
    """Reference instances of `pieces` within `radius` of `centre`, once each."""
    remaining = {}
    for part, color in pieces:
        remaining[(str(part), int(color))] = remaining.get((str(part), int(color)), 0) + 1
    found = []
    centre = np.asarray(centre, float)
    for part, color, position, frame in sorted(
            truth, key=lambda row: float(np.linalg.norm(row[2] - centre))):
        key = (str(part), int(color))
        if remaining.get(key) and np.linalg.norm(position - centre) <= radius:
            remaining[key] -= 1
            transform = np.eye(4)
            transform[:3, :3] = frame
            transform[:3, 3] = position
            found.append((str(part), int(color), transform))
    return found, {f'{p}:{c}': n for (p, c), n in remaining.items() if n}


def diagnose(truth_path, pieces, centre, radius):
    from placement_diagnose_alias_poses import canonicalize
    from placement_part_library import PartLibrary
    from pose_score import read_parts
    library = PartLibrary()
    truth, aliases = canonicalize(read_parts(truth_path), library)
    canonical = [(library.resolve(part).stem, int(color)) for part, color in pieces]
    items, unfound = locate(truth, canonical, centre, radius)
    groups, edges = components(items)
    return dict(truth=str(truth_path), requested=[list(p) for p in pieces],
                canonical=[list(p) for p in canonical], aliases=aliases,
                centre=list(map(float, centre)), radius_ldu=float(radius),
                located=[dict(part=p, color=c, position=[float(v) for v in T[:3, 3]])
                         for p, c, T in items],
                unlocated=unfound,
                components=[[dict(part=items[i][0], color=items[i][1],
                                  position=[float(v) for v in items[i][2][:3, 3]])
                             for i in group] for group in groups],
                component_sizes=[len(group) for group in groups],
                mates=[dict(edge, a_part=items[edge['a']][0], b_part=items[edge['b']][0])
                       for edge in edges],
                one_group=len(groups) == 1,
                scope='Evaluation-only. Reads the independent model to say whether a page\'s '
                      'allocation is a well-posed rigid group; nothing here selects a runtime '
                      'pose or enters candidate generation.',
                limitations='Connectivity is the connector-mate predicate only: two pieces held '
                            'together solely by a third, or by friction the shadow library does '
                            'not record, read as separate. Instances are located by part, colour '
                            'and proximity to a supplied centre, which is an argument.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--truth', default='C:/git/clego/lego_sets/OMR/40377-1.mpd')
    parser.add_argument('--allocation-run', type=Path)
    parser.add_argument('--page', type=int)
    parser.add_argument('--pieces', nargs='*', default=[], metavar='PART:COLOUR')
    parser.add_argument('--centre', type=float, nargs=3, required=True)
    parser.add_argument('--radius', type=float, default=45.0)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    pieces = [(p.split(':')[0], int(p.split(':')[1])) for p in args.pieces]
    if args.allocation_run is not None and args.page is not None:
        assignment = json.loads((args.allocation_run / 'global-assignment.json').read_text())
        pieces = [(row['part'], int(row['color']))
                  for row in assignment['evidence'] if row['page'] == args.page
                  for _ in range(int(row['qty']))]
    record = diagnose(args.truth, pieces, args.centre, args.radius)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(json.dumps(dict(located=len(record['located']), unlocated=record['unlocated'],
                          component_sizes=record['component_sizes'],
                          one_group=record['one_group'])))
    print(args.out)
