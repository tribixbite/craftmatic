"""Read live-index snapshot and local evidence; write reproducible audit facts."""
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
BASE = Path('C:/git/clego')
OUT = ROOT / 'output/pdf-recon-audit'
sys.path.insert(0, str(BASE))
sys.dont_write_bytecode = True


def is_recon(src):
    return src == 'pdf_recon' or src.startswith('recon')


def main():
    idx = json.loads((OUT / 'live-index.json').read_text())
    only, best_counts, live_v8 = [], Counter(), []
    for sn, entry in idx['sets'].items():
        models = entry['models']
        if not models:
            continue
        best = models[0]
        if best.get('conv'):
            best = next((m for m in models if not m.get('conv')), best)
        best_counts[best['src']] += 1
        if all(is_recon(m['src']) for m in models):
            only.append(sn)
        if any(m['src'] == 'recon_v8' for m in models):
            live_v8.append(sn)
    bi = json.loads((BASE / 'biapp_instructions.json').read_text())
    local_pdf = []
    for sn in only:
        if any((BASE / 'lego_sets/PDF' / f"{f.get('Id')}.pdf").exists()
               for f in bi.get(sn, {}).get('InstructionFiles', [])):
            local_pdf.append(sn)
    files = list((BASE / 'lego_sets/ReconV8').glob('*.ldr'))
    generated = sorted({re.match(r'^(\d+)', p.stem).group(1) for p in files
                        if re.match(r'^(\d+)', p.stem)})
    coverage = {'live_index_generated': idx.get('generated'),
                'live_index_sha256': hashlib.sha256((OUT / 'live-index.json').read_bytes()).hexdigest(),
                'indexed_sets': len(idx['sets']), 'best_sources': dict(best_counts),
                'reconstruction_only_count': len(only), 'reconstruction_only_sets': sorted(only),
                'reconstruction_only_with_local_pdf': len(local_pdf),
                'v8_files': len(files), 'v8_generated_sets': generated,
                'v8_generated_reconstruction_only_sets': sorted(set(generated) & set(only)),
                'v8_live_sets': sorted(live_v8)}
    (OUT / 'coverage.json').write_text(json.dumps(coverage, indent=2))

    import pymupdf
    spec = importlib.util.spec_from_file_location('pdf_inventory',
        BASE / 'recon_extract/pdf_inventory.py')
    bom = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bom)
    catalog = bom.load_catalog(BASE / 'elements.csv')
    from pose_score import read_parts, score
    from recon_v7.idmatch import score as loose_score, recon_items, truth_items
    results = []
    for sn in ['41624', '40377', '3931']:
        truth = BASE / f'lego_sets/OMR/{sn}-1.mpd'
        if not truth.exists():
            continue
        cases = sorted(OUT.glob(f'deterministic-v*/*/{sn}/{sn}.ldr'))
        for suffix in ['', '_vlmbase_fresh']:
            p = BASE / f'lego_sets/ReconV8/{sn}{suffix}.ldr'
            if p.exists():
                cases.append(p)
        for path in cases:
            result = score(read_parts(path), read_parts(truth))
            result.update(set=sn, path=str(path), truth=str(truth),
                          loose_identity_pm2=loose_score(recon_items(path), truth_items(truth), tol=2))
            results.append(result)
        cache = OUT / f'deterministic-v1/contact/{sn}/pdfpick_cache.json'
        if cache.exists():
            pdf = json.loads(cache.read_text())[sn]['pdf']
            with pymupdf.open(pdf) as doc:
                inventory = bom.extract(doc, catalog)
            inventory['pdf'] = pdf
            (OUT / f'{sn}-pdf-inventory.json').write_text(json.dumps(inventory, indent=2))
    (OUT / 'poses.json').write_text(json.dumps(results, indent=2))
    control_path = BASE / 'lego_sets/OMR/41624-1.mpd'
    control = read_parts(control_path)
    (OUT / 'pose-positive-control.json').write_text(json.dumps(score(control, control), indent=2))
    print(json.dumps({k: v for k, v in coverage.items() if not k.endswith('_sets')}, indent=2))
    for r in results:
        print(r['set'], Path(r['path']).parent.name, Path(r['path']).name,
              'pose', round(r['coverage'] * 100, 2), 'loose', r['loose_identity_pm2'])


if __name__ == '__main__':
    main()
