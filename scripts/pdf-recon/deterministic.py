"""Zero-VLM placement diagnostic; outputs are not certified production models.

Defaults to PDF inventory; --inventory io is an explicitly recorded diagnostic aid.
Compares geometric ranking with deterministic render-to-page template ranking.
All outputs are quarantined; uncertain geometry is never published by this tool.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = Path('C:/git/clego')
sys.path.insert(0, str(BASE))
sys.dont_write_bytecode = True


def run(sn, strategy, label, inventory_source, reference_source):
    import numpy as np
    from recon_v7 import pipeline, pdfpick, vlm
    from recon_v8 import place
    from recon_v8.pagerank import PageContext
    from recon_extract.q1_deterministic import DeterministicQ1Front
    from recon_v3.common import ordered_inventory
    from recon_v7.partnames import is_nonbuildable
    import importlib.util
    spec = importlib.util.spec_from_file_location('pdf_inventory',
        BASE / 'recon_extract/pdf_inventory.py')
    bom = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bom)

    def forbidden(*args, **kwargs):
        raise RuntimeError('VLM runtime calls are forbidden in this runner')
    vlm.ask = vlm.ask_json = vlm._post = forbidden
    work = ROOT / 'output/pdf-recon-audit' / label / strategy / sn
    work.mkdir(parents=True, exist_ok=True)
    if (work / 'result.json').exists():
        raise RuntimeError(f'Result already exists: {work}; choose a new label')
    pdfpick.CACHE = work / 'pdfpick_cache.json'
    pages = pipeline.render_pages(sn, work, 'auto')
    pdf, info = pdfpick.pick(sn)
    import pymupdf
    with pymupdf.open(pdf) as doc:
        catalog = bom.bridge_catalog(bom.load_studio_catalog(
            BASE / 'extracted/studio_earlyaccess/app/data'), bom.load_catalog(BASE / 'elements.csv'))
        inventory_evidence = bom.extract(doc, catalog, namespace='ldraw')
    (work / 'pdf-inventory.json').write_text(json.dumps(inventory_evidence, indent=2))
    if inventory_source == 'pdf':
        from recon_v3.common import get_part_dims
        counts = Counter()
        for r in inventory_evidence['records']:
            if 'part' in r and not is_nonbuildable(r['part']):
                dims = get_part_dims(r['part'])
                counts[(int(r['color']), r['part'], *map(int, dims))] += r['qty']
        if not counts:
            raise RuntimeError('No PDF-derived inventory; .io fallback is forbidden')
    else:
        counts = Counter(tuple(r) for r in ordered_inventory(sn)
                         if not is_nonbuildable(r[1]))
    rows = [list(r) + [n] for r, n in counts.items()]
    inventory = sum(r[-1] for r in rows)
    front = DeterministicQ1Front(sn, rows, page_mode='auto')
    if reference_source == 'pdf':
        icon_spec = importlib.util.spec_from_file_location('pdf_icon_matcher',
            BASE / 'recon_extract/pdf_icon_matcher.py')
        icons = importlib.util.module_from_spec(icon_spec)
        icon_spec.loader.exec_module(icons)
        front.resolver = icons.build_resolver(front.doc, inventory_evidence,
                                               front.style.pli_bg, work / 'bom-icons')
    asm = place.new_assembly()
    journal, unresolved = [], []
    previous = previous_ctx = previous_pos = None
    started = time.time()
    for pg, png in pages:
        if pg in inventory_evidence['inventory_pages']:
            journal.append({'q': 'parts', 'page': pg, 'role': 'inventory', 'adds': []})
            continue
        ans, raw = front.adds_for_page(pg, rows)
        adds = ans.get('adds', [])
        if ans.get('needs_vlm'):
            unresolved.append({'page': pg, 'reason': 'reader requires unresolved evidence'})
        journal.append({'q': 'parts', 'page': pg, 'ans': ans, 'raw': raw})
        ctx = None
        if strategy == 'template' and adds:
            ctx = PageContext(previous, png)
            ctx.prev_ctx = previous_ctx
            if not ctx.ok:
                ctx = None
        if adds:
            previous = png
        for addition in adds:
            index = addition['index']
            color, part, w, hp, d, remaining = rows[index]
            qty = min(remaining, addition.get('qty', 1))
            for instance in range(qty):
                if not asm.parts:
                    chosen = np.eye(4)
                    evidence = {'seed': True}
                else:
                    picks, stats = place.rank_candidates(
                        asm, part, previous_pos, k=90, budget=90,
                        pagectx=ctx, color=color, page_prefilter=False)
                    if not picks:
                        unresolved.append({'page': pg, 'part': part, 'reason': 'no legal mate'})
                        continue
                    evidence = {'stats': stats, 'candidate_count': len(picks),
                                'verified': False}
                    chosen = picks[0]['T']
                    if strategy == 'template' and ctx is not None and ctx.ready:
                        from recon_v8.template import locate
                        from recon_v8.pointing import candidate_px
                        result = locate(ctx, asm, part, color, [c['T'] for c in picks])
                        if result and result.get('points'):
                            points = np.asarray(result['points'], float)
                            px = candidate_px(ctx, part, [c['T'] for c in picks])
                            distances = np.linalg.norm(px[:, None, :] - points[None, :, :], axis=2)
                            rank = np.min(distances, axis=1)
                            best = int(np.argmin(rank))
                            chosen = picks[best]['T']
                            evidence.update(template_distance=float(rank[best]), template_rank=best)
                asm.add(part, color, chosen)
                previous_pos = chosen[:3, 3]
                rows[index][-1] -= 1
                journal.append({'q': 'place', 'page': pg, 'part': part,
                                'color': color, 'T': chosen.tolist(), **evidence})
        if ctx is not None:
            previous_ctx = ctx
        print(f'{sn} {strategy} page={pg} placed={len(asm.parts)}/{inventory}', flush=True)
        (work / 'journal.json').write_text(json.dumps(journal, indent=1))
    front.close()
    model = work / f'{sn}.ldr'
    model.write_text(asm.to_ldr(f'0 Deterministic PDF reconstruction diagnostic of {sn}\n'
                               '0 !LINEAGE recon_pdf_deterministic partial'))
    result = {'set': sn, 'strategy': strategy, 'vlm_calls': 0,
              'pdf_only': inventory_source == 'pdf',
              'reference_source': reference_source,
              'inventory_source': ('PDF element labels + universal Studio tables'
                                   if inventory_source == 'pdf' else 'legacy set .io, not PDF'),
              'certified': False, 'placed': len(asm.parts), 'inventory': inventory,
              'unresolved': unresolved, 'pdf': info,
              'pdf_sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
              'model_sha256': hashlib.sha256(model.read_bytes()).hexdigest(),
              'seconds': time.time() - started, 'reader_stats': front.stats}
    (work / 'result.json').write_text(json.dumps(result, indent=2))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('sets', nargs='+')
    ap.add_argument('--strategy', choices=['contact', 'template'], default='contact')
    ap.add_argument('--label', default='deterministic-v1')
    ap.add_argument('--inventory', choices=['pdf', 'io'], default='pdf')
    ap.add_argument('--references', choices=['pdf', 'synthetic'], default='pdf')
    args = ap.parse_args()
    for sn in args.sets:
        run(sn, args.strategy, args.label, args.inventory, args.references)
