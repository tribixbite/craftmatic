"""Compare PDF-derived BOM identities to independent truth; evaluation only."""
from collections import Counter
import json
from pathlib import Path
import sys
from pose_score import read_parts


def main(directory, truth_path):
    inventory = json.loads((directory / 'inventory.json').read_text(encoding='utf-8'))
    pdf = Counter()
    for row in inventory['records']:
        if 'part' in row:
            pdf[(str(row['part']).removesuffix('.dat'), int(row['color']))] += row['qty']
    truth = Counter((part, color) for part, color, _, _ in read_parts(truth_path))
    matched = sum((pdf & truth).values())
    def rows(counter):
        return [{'part': key[0], 'color': key[1], 'qty': qty} for key, qty in sorted(counter.items())]
    result = {'scope': 'PDF BOM versus independent truth inventory; never assembly input',
              'truth': str(truth_path), 'truth_pieces': sum(truth.values()),
              'pdf_resolved_pieces': sum(pdf.values()), 'exact_part_color_overlap': matched,
              'exact_inventory_coverage_ceiling': matched / sum(truth.values()),
              'pdf_only_identities': rows(pdf - truth), 'truth_only_identities': rows(truth - pdf),
              'limitations': 'Exact identifiers; alternative mold/catalog naming and spare parts not reconciled'}
    (directory / 'inventory-ceiling.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
