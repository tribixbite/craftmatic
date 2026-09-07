"""Bounded real-PDF artwork retrieval trials, not full assembly certification."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import random
import sys
import time

os.environ.setdefault('CUBLAS_WORKSPACE_CONFIG', ':4096:8')
BASE = Path('C:/git/clego')
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf-recon-trials'
sys.path.insert(0, str(BASE))


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2), encoding='utf-8')


def canonical(rgb, size=64):
    import cv2
    import numpy as np
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    mask = np.linalg.norm(rgb.astype(float) - bg, axis=2) > 32
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype('uint8'), 8)
    if n < 2:
        return None
    keep = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    if stats[keep, cv2.CC_STAT_AREA] < 30:
        return None
    x, y, w, h = stats[keep, :4]
    if min(w, h) < 5:
        return None
    crop = rgb[y:y+h, x:x+w].copy()
    fg = mask[y:y+h, x:x+w]
    crop[~fg] = 255
    scale = (size - 8) / max(w, h)
    nw, nh = max(1, round(w*scale)), max(1, round(h*scale))
    result = np.full((size, size, 3), 255, dtype='uint8')
    left, top = (size-nw)//2, (size-nh)//2
    result[top:top+nh, left:left+nw] = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)
    return result


def harvest(limit):
    import cv2
    import numpy as np
    import pymupdf
    from recon_extract import pdf_inventory as bom
    from recon_extract.pdf_icon_matcher import icon_box
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / 'artwork.json').exists():
        raise ValueError('Artwork manifest already exists; preserve it before a new harvest')
    (OUT / 'artwork').mkdir(exist_ok=True)
    forbidden = set(json.loads((BASE / 'tmp_cohort_sample.json').read_text())) | {'41624', '3931', '910058'}
    cat = json.loads((ROOT / 'output/pdf-recon-audit/live-catalog.json').read_text(encoding='utf-8'))
    sizes = {r['set_num'].split('-')[0]: r.get('num_parts', 0) for r in cat['sets']}
    bi = json.loads((BASE / 'biapp_instructions.json').read_text())
    sets = [sn for sn in bi if 20 <= (sizes.get(sn) or 0) <= 200]
    sets.sort(key=lambda s: hashlib.sha256(('artwork-v1/'+s).encode()).hexdigest())
    sets = ['41624', '40377', '3931'] + [s for s in sets if s not in {'41624', '40377', '3931'}]
    catalog = bom.bridge_catalog(bom.load_studio_catalog(BASE / 'extracted/studio_earlyaccess/app/data'), bom.load_catalog(BASE / 'elements.csv'))
    records, booklets, seen_pdf = [], [], set()
    for sn in sets:
        paths = [BASE / f'lego_sets/PDF/{r.get("Id")}.pdf' for r in bi[sn].get('InstructionFiles', [])]
        paths = [p for p in paths if p.exists()]
        if not paths:
            continue
        # Input selection uses PDF size only, never a truth build.
        pdf = max(paths, key=lambda p: p.stat().st_size)
        digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
        if digest in seen_pdf:
            continue
        seen_pdf.add(digest)
        bucket = int(hashlib.sha256(sn.encode()).hexdigest()[:8], 16) % 10
        split = 'test' if sn in forbidden or bucket >= 8 else ('val' if bucket == 7 else 'train')
        local = []
        with pymupdf.open(pdf) as doc:
            if len(doc) > 120:
                continue
            # BOM normally sits at the end. Record the bounded search explicitly.
            pages = sorted(set([0, 1] + list(range(max(0, len(doc)-6), len(doc)))))
            inv_records = []
            for pg in pages:
                if pg >= len(doc) or not bom.is_inventory_page(doc[pg]):
                    continue
                for r in bom.inventory_labels(doc[pg].get_text('words'))[0]:
                    options = catalog.get(r['element_id'], set())
                    if len(options) == 1:
                        part, color = next(iter(options))
                        inv_records.append(dict(r, page=pg, part=part, color=color))
            for rec in inv_records:
                page = doc[rec['page']]
                box = icon_box(page, rec, inv_records)
                if box is None:
                    continue
                pix = page.get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=pymupdf.Rect(box), alpha=False)
                rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
                norm = canonical(rgb)
                if norm is None:
                    continue
                filename = f'artwork/{sn}_{rec["page"]}_{rec["element_id"]}.png'
                cv2.imwrite(str(OUT / filename), cv2.cvtColor(norm, cv2.COLOR_RGB2BGR))
                local.append(dict(set=sn, split=split, pdf=str(pdf), pdf_sha256=digest,
                                  page=rec['page'], element=rec['element_id'], part=rec['part'],
                                  color=rec['color'], image=filename, bbox=list(box),
                                  image_sha256=hashlib.sha256(norm.tobytes()).hexdigest()))
            # Exact XObject reuse is a separate, non-neural identity opportunity.
            inventory_digests = set()
            for pg in set(r['page'] for r in inv_records):
                inventory_digests.update(i['digest'].hex() for i in doc[pg].get_image_info(hashes=True))
            other_digests = set()
            for pg in range(len(doc)):
                if pg not in set(r['page'] for r in inv_records):
                    other_digests.update(i['digest'].hex() for i in doc[pg].get_image_info(hashes=True))
            reused = len(inventory_digests & other_digests)
        if len(local) < 4:
            continue
        records.extend(local)
        booklets.append(dict(set=sn, split=split, icons=len(local), reused_image_digests=reused))
        print(f'booklet={sn} split={split} icons={len(local)} accepted={len(booklets)}/{limit}', flush=True)
        if len(booklets) >= limit:
            break
    write('artwork.json', {'records': records, 'booklets': booklets, 'forbidden_training_sets': sorted(forbidden),
          'limitations': ['Printed element labels supervise BOM artwork, not step localization',
                         'Crop segmentation and namespace mapping require visual audit',
                         'Inventory search restricted to first two/last six pages'],
          'runtime_vlm_calls': 0})


def features(images, mode):
    import cv2
    import numpy as np
    if mode == 'pixels':
        f = (1 - images.astype('float32') / 255).reshape(len(images), -1)
    else:
        hog = cv2.HOGDescriptor((64, 64), (16, 16), (8, 8), (8, 8), 9)
        f = np.stack([hog.compute(cv2.cvtColor(im, cv2.COLOR_RGB2GRAY)).ravel() for im in images])
    return f / np.maximum(np.linalg.norm(f, axis=1, keepdims=True), 1e-8)


def retrieval(emb, records, split):
    import numpy as np
    train = [i for i, r in enumerate(records) if r['split'] == 'train']
    query = [i for i, r in enumerate(records) if r['split'] == split]
    sims = emb[query] @ emb[train].T
    rows = []
    for qi, i in enumerate(query):
        r = records[i]
        # Color is provided by the PDF label here: isolates SHAPE recognition.
        eligible = [k for k, j in enumerate(train) if records[j]['color'] == r['color']
                    and records[j]['image_sha256'] != r['image_sha256']]
        seen = any(records[train[k]]['part'] == r['part'] for k in eligible)
        ranked = sorted(eligible, key=lambda k: -sims[qi, k])
        ids = list(dict.fromkeys(records[train[k]]['part'] for k in ranked))
        rows.append(dict(set=r['set'], image=r['image'], truth=r['part'], color=r['color'],
                         available=seen, prediction=ids[0] if ids else None,
                         top1=bool(ids and ids[0] == r['part']), top5=r['part'] in ids[:5]))
    available = [r for r in rows if r['available']]
    return {'queries': len(rows), 'available': len(available),
            'top1_available': sum(r['top1'] for r in available),
            'top5_available': sum(r['top5'] for r in available), 'rows': rows}


def train(steps,degrade=False):
    import cv2
    import numpy as np
    import torch
    from torch import nn
    import torch.nn.functional as F
    torch.set_num_threads(4)
    torch.manual_seed(742)
    random.seed(742)
    np.random.seed(742)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    if device == 'cuda':
        torch.cuda.set_per_process_memory_fraction(.10)
    data = json.loads((OUT / 'artwork.json').read_text())
    records = data['records']
    assert not set(r['set'] for r in records if r['split'] == 'train') & set(data['forbidden_training_sets'])
    images = np.stack([cv2.cvtColor(cv2.imread(str(OUT / r['image'])), cv2.COLOR_BGR2RGB) for r in records])
    # Identical normalized artwork must not leak from train into evaluation.
    results = {'scope': 'cross-booklet BOM shape retrieval; PDF color given; exact-image matches excluded',
               'device': device, 'steps': steps, 'baselines': {}, 'runtime_vlm_calls': 0,
               'resolution_degradation':degrade}
    checkpoint_name='artwork-encoder-lowres.pt' if degrade else 'artwork-encoder.pt'
    for mode in ('pixels', 'hog'):
        emb = features(images, mode)
        results['baselines'][mode] = {s: retrieval(emb, records, s) for s in ('val', 'test')}
    class Encoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(nn.Conv2d(3, 24, 5, 2, 2), nn.ReLU(),
                nn.Conv2d(24, 48, 3, 2, 1), nn.ReLU(), nn.Conv2d(48, 64, 3, 2, 1), nn.ReLU(),
                nn.Flatten(), nn.Linear(64*8*8, 96))
        def forward(self, x):
            return F.normalize(self.net(x), dim=1)
    model = Encoder().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=.0004, weight_decay=.001)
    keys = sorted(set(r['part'] for r in records if r['split'] == 'train'))
    groups = {k: [i for i,r in enumerate(records) if r['part'] == k and r['split'] == 'train'] for k in keys}
    tensor = torch.tensor(images.transpose(0, 3, 1, 2), dtype=torch.float32) / 255
    def augment(x):
        count = len(x)
        theta = torch.eye(2, 3, device=device).repeat(count, 1, 1)
        theta[:, 0, 0] = theta[:, 1, 1] = .85 + torch.rand(count, device=device)*.3
        theta[:, :, 2] = (torch.rand(count, 2, device=device)-.5)*.10
        grid = F.affine_grid(theta, x.size(), align_corners=False)
        x = 1-F.grid_sample(1-x, grid, align_corners=False)
        gray = x.mean(1, keepdim=True).expand_as(x)
        mix = torch.rand(count, 1, 1, 1, device=device)
        x=(x*(1-mix)+gray*mix+torch.randn_like(x)*.025).clamp(0, 1)
        if degrade:
            size=random.choice([16,20,24,32,48,64])
            x=F.interpolate(F.interpolate(x,size=(size,size),mode='bilinear',align_corners=False),size=(64,64),mode='bilinear',align_corners=False)
        return x
    def encode():
        model.eval()
        with torch.no_grad():
            return torch.cat([model(tensor[i:i+64].to(device)).cpu() for i in range(0, len(tensor), 64)]).numpy()
    best, history, started = -1, [], time.time()
    for step in range(steps):
        model.train()
        selected = random.sample(keys, min(24, len(keys)))
        ia = [random.choice(groups[k]) for k in selected]
        ib = [random.choice(groups[k]) for k in selected]
        a, b = model(augment(tensor[ia].to(device))), model(augment(tensor[ib].to(device)))
        logits = a @ b.T / .12
        labels = torch.arange(len(selected), device=device)
        loss = (F.cross_entropy(logits, labels)+F.cross_entropy(logits.T, labels)) / 2
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        if (step+1) % 100 == 0 or step+1 == steps:
            emb = encode()
            val = retrieval(emb, records, 'val')
            score = val['top1_available'] / max(val['available'], 1)
            record = {'step': step+1, 'loss': float(loss.detach()), 'val_top1': score}
            history.append(record)
            print(record, flush=True)
            if score > best:
                best = score
                torch.save(model.state_dict(), OUT / checkpoint_name)
                results['best_step'] = step+1
    model.load_state_dict(torch.load(OUT / checkpoint_name, weights_only=True, map_location=device))
    emb = encode()
    results['learned'] = {s: retrieval(emb, records, s) for s in ('val', 'test')}
    # Transfer check on actual step PLI crops. Labels never select candidates
    # or enter training. This historical benchmark is noisy, so it diagnoses
    # domain transfer rather than certifying accuracy.
    from recon_extract.label_schema import label_error
    bench = BASE / 'recon_extract/fixtures/pli_bench'
    labels = json.loads((bench / 'labels.json').read_text())
    labels = [r for r in labels if not label_error(r)]
    queries, qrows = [], []
    for row in labels:
        im = cv2.imread(str(bench / 'crops' / row['file']))
        if im is None:
            continue
        im = canonical(cv2.cvtColor(im, cv2.COLOR_BGR2RGB))
        if im is not None:
            queries.append(im)
            qrows.append(row)
    if queries:
        qimages = np.stack(queries)
        with torch.no_grad():
            qlearned = model(torch.tensor(qimages.transpose(0, 3, 1, 2), dtype=torch.float32, device=device)/255).cpu().numpy()
        transfers = {}
        for mode, qe, re in [('pixels', features(qimages, 'pixels'), features(images, 'pixels')),
                             ('hog', features(qimages, 'hog'), features(images, 'hog')),
                             ('learned', qlearned, emb)]:
            rows = []
            for i, row in enumerate(qrows):
                candidates = [j for j,r in enumerate(records) if r['set'] == row['set']]
                if not candidates:
                    continue
                sims = qe[i] @ re[candidates].T
                pred = records[candidates[int(np.argmax(sims))]]
                truth = (row['part'].removesuffix('.dat'), str(row['color']))
                available = any((records[j]['part'], records[j]['color']) == truth for j in candidates)
                rows.append(dict(file=row['file'], set=row['set'], truth=list(truth),
                                 prediction=[pred['part'], pred['color']], available=available,
                                 exact=(pred['part'], pred['color']) == truth,
                                 set_seen_in_training=row['set'] in {r['set'] for r in records if r['split']=='train'}))
            transfers[mode] = {'queries': len(rows), 'available': sum(r['available'] for r in rows),
                               'exact': sum(r['exact'] for r in rows), 'rows': rows}
        results['step_pli_transfer_no_color_oracle'] = transfers
    results['history'] = history
    results['seconds'] = time.time()-started
    results['peak_gpu_bytes'] = torch.cuda.max_memory_allocated() if device == 'cuda' else 0
    results['parameters'] = sum(p.numel() for p in model.parameters())
    results['checkpoint_sha256'] = hashlib.sha256((OUT / checkpoint_name).read_bytes()).hexdigest()
    output_name='matching-results-lowres.json' if degrade else 'matching-results.json'
    write(output_name, results)
    print('saved '+output_name, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['harvest', 'train'])
    parser.add_argument('--booklets', type=int, default=80)
    parser.add_argument('--steps', type=int, default=600)
    parser.add_argument('--degrade',action='store_true')
    args = parser.parse_args()
    harvest(args.booklets) if args.action == 'harvest' else train(args.steps,args.degrade)
