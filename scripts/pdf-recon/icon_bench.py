"""Score PDF-derived icon references on the existing 92-item labeled bench.

Labels are used only for scoring. Candidate identities and counts come solely
from the PDF's element inventory and universal catalog mappings.
"""
from collections import Counter, defaultdict
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
BASE = Path('C:/git/clego')
sys.path.insert(0, str(BASE))
sys.dont_write_bytecode = True


def load(name):
    path = BASE / f'recon_extract/{name}.py'
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    import cv2
    import pymupdf
    from recon_v7 import pdfpick
    from recon_extract.bench_eval import bg_for
    bom, icons = load('pdf_inventory'), load('pdf_icon_matcher')
    out = ROOT / 'output/pdf-recon-audit/icon-bench'
    out.mkdir(parents=True, exist_ok=True)
    pdfpick.CACHE = out / 'pdfpick_cache.json'
    catalog = bom.bridge_catalog(bom.load_studio_catalog(
        BASE / 'extracted/studio_earlyaccess/app/data'), bom.load_catalog(BASE / 'elements.csv'))
    bench = BASE / 'recon_extract/fixtures/pli_bench'
    labels = json.loads((bench / 'labels.json').read_text())
    schema = load('label_schema')
    invalid = [dict(r, quarantine_reason=schema.label_error(r)) for r in labels if schema.label_error(r)]
    labels = [r for r in labels if not schema.label_error(r)]
    (out / 'quarantined-labels.json').write_text(json.dumps(invalid, indent=2))
    by_set = defaultdict(list)
    for row in labels:
        by_set[row['set']].append(row)
    results, summary = [], []
    for sn, rows in by_set.items():
        pdf, _ = pdfpick.pick(sn)
        with pymupdf.open(pdf) as doc:
            inventory = bom.extract(doc, catalog, namespace='ldraw')
            try:
                matcher = icons.build_resolver(doc, inventory, bg_for(rows[0]['era']), out / sn)
            except RuntimeError:
                matcher = None
        remaining = Counter()
        for r in inventory['records']:
            if 'part' in r:
                remaining[(r['part'], r['color'])] += r['qty']
        local = []
        for row in rows:
            crop = cv2.cvtColor(cv2.imread(str(bench / 'crops' / row['file'])), cv2.COLOR_BGR2RGB)
            pred = matcher.match(crop, qty=row['qty'], remaining=remaining) if matcher else None
            correct = (pred is not None and pred['part'].removesuffix('.dat') == row['part'].removesuffix('.dat')
                       and str(pred['color']) == str(row['color']))
            local.append(dict(row, prediction=pred, exact=correct,
                              identity_in_pdf_candidates=(row['part'].removesuffix('.dat'), str(row['color'])) in remaining))
        results.extend(local)
        summary.append({'set': sn, 'items': len(local), 'exact': sum(r['exact'] for r in local),
                        'identity_available': sum(r['identity_in_pdf_candidates'] for r in local),
                        'pdf_inventory_pieces': inventory['pieces'],
                        'mapped_inventory_pieces': inventory['resolved_pieces']})
        print(summary[-1], flush=True)
    result = {'rows': results, 'sets': summary, 'exact': sum(r['exact'] for r in results),
              'items': len(results), 'quarantined_labels': len(invalid),
              'vlm_calls': 0, 'trained_on_benchmark': False,
              'limitations': 'Existing labels include truth_auto; exact LDraw names, no mold equivalence'}
    (out / 'result.json').write_text(json.dumps(result, indent=2))
    print('TOTAL', result['exact'], '/', result['items'])


if __name__ == '__main__':
    main()
