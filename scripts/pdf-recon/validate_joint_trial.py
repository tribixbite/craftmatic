"""Independently check joint-assignment evidence; not an accuracy certificate."""
from collections import Counter
import json
from pathlib import Path
import sys


def validate(inventory, assignment, journal):
    capacities = Counter()
    for row in inventory['records']:
        if 'part' in row:
            capacities[(str(row['part']).removesuffix('.dat'), str(row['color']))] += row['qty']
    used, expected, actual = Counter(), Counter(), Counter()
    anchors = set()
    for row in assignment['evidence']:
        qty = row['qty']
        if type(qty) is not int or qty <= 0:
            raise ValueError('Quantity must be a positive integer')
        anchor = (row['page'], tuple(row['anchor']))
        if anchor in anchors:
            raise ValueError('Callout assigned more than once')
        anchors.add(anchor)
        key = (str(row['part']).removesuffix('.dat'), str(row['color']))
        used[key] += qty
        expected[(row['page'], *key)] += qty
    if any(qty > capacities[key] for key, qty in used.items()):
        raise ValueError('Assigned quantity exceeds PDF inventory capacity')
    if assignment['assigned'] != len(anchors) or assignment['assigned_pieces'] != sum(used.values()):
        raise ValueError('Reported assignment totals disagree with evidence')
    for event in journal:
        for row in event.get('placements', []):
            actual[(event['page'], str(row['part']).removesuffix('.dat'), str(row['color']))] += 1
    if actual - expected:
        raise ValueError('Placed part has no matching page assignment')
    return {'capacity_constraints_pass': True, 'unique_callout_assignments_pass': True,
            'placement_assignments_pass': True, 'assigned_pieces': sum(used.values()),
            'placed_pieces': sum(actual.values()), 'assigned_but_unplaced': sum((expected - actual).values()),
            'accuracy_certified': False}


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    def read(name):
        return json.loads((directory / name).read_text(encoding='utf-8'))
    result = validate(read('inventory.json'), read('global-assignment.json'), read('journal.json'))
    (directory / 'assignment-validation.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
