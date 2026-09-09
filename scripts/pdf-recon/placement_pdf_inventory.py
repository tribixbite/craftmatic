"""The printed BOM of a PDF, as the pipeline's only external input.

Every measured run in this program has started from an `inventory.json` produced
by some earlier trial, which made "PDF-only" true of the pipeline but awkward to
demonstrate: a new fixture needed one of those trials re-run first. This is the
extraction on its own - `recon_extract.pdf_inventory.extract` over the
instruction booklet's own inventory pages, against the Studio element catalog -
so `placement_autonomous_run` can take a PDF and nothing else.

No reference, no VLM, no poses: an element id, a colour, a count and the icon's
box on the page. Whether the element maps to one LDraw name, several, or none is
recorded and never guessed.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

BASE = Path('C:/git/clego')
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def extract(pdf, out):
    import pymupdf
    from recon_extract import pdf_inventory as bom
    pdf, out = Path(pdf), Path(out)
    with pymupdf.open(pdf) as doc:
        data = BASE / 'extracted/studio_earlyaccess/app/data'
        catalog = bom.bridge_catalog(bom.load_studio_catalog(data), bom.load_catalog(BASE / 'elements.csv'))
        inventory = bom.extract(doc, catalog, namespace='ldraw')
    records = inventory['records']
    summary = dict(pdf=str(Path(pdf).resolve()),
                   pdf_sha256=hashlib.sha256(Path(pdf).read_bytes()).hexdigest(),
                   records=len(records), printed_pieces=sum(record['qty'] for record in records),
                   mapped_records=sum(1 for record in records if 'part' in record),
                   ambiguous_records=sum(1 for record in records
                                         if 'part' not in record and len(record.get('candidates') or []) > 1),
                   unmapped_records=sum(1 for record in records
                                        if 'part' not in record and not record.get('candidates')),
                   truth_used=False, runtime_vlm_calls=0, certified=False,
                   limitations=['The printed inventory is transcribed, not verified against a '
                                'reference; an element with several LDraw names stays several.'])
    out.mkdir(parents=True, exist_ok=True)
    (out / 'inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
    (out / 'inventory-manifest.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps({key: summary[key] for key in
                      ('records', 'printed_pieces', 'mapped_records', 'ambiguous_records',
                       'unmapped_records')}))
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    extract(args.pdf, args.out)


if __name__ == '__main__':
    main()
