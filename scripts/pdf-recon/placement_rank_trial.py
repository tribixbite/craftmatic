"""Cross-set learned ranking diagnostic on historical truth-state caches.

Not PDF-only end-to-end accuracy. No VLM-derived hint features are admitted.
Cached targets use the historical permissive identity/2 LDU/5 degree protocol.
"""
import json
from pathlib import Path
import pickle
import sys
import numpy as np

BASE = Path('C:/git/clego')
OUT = Path(__file__).resolve().parents[2] / 'output/pdf-recon-trials'
sys.path.insert(0, str(BASE))


def main():
    import torch
    from torch import nn
    torch.set_num_threads(4)
    torch.manual_seed(743)
    torch.use_deterministic_algorithms(True)
    names = ['contact', 'page', 'dist', 'dr_col_ink', 'dr_col_new', 'dr_ink',
             'dr_ink_new', 'dr_spill', 'dr_vis', 'dr_col_vis', 'dr_ink_vis']
    caches = {}
    for sn in ['3931', '41624']:
        path = BASE / f'recon_v8/sigcache_{sn}_b900.pkl'
        if not path.exists():
            path = BASE / f'recon_v8/sigcache_{sn}_b90.pkl'
        # Only trusted locally generated repository cache, never downloaded pickle.
        caches[sn] = pickle.loads(path.read_bytes())
    def features(row):
        values = []
        for name in names:
            v = np.asarray(row['sig'].get(name, np.zeros(row['n'])), dtype='float32')
            v = np.nan_to_num(v, nan=0, posinf=0, neginf=0)
            if name in ('contact', 'page'):
                v = (v-v.min()) / max(float(np.ptp(v)), 1e-8)
            if name == 'dist':
                v = np.exp(-v/80)
            values.append(v)
        return torch.tensor(np.stack(values, axis=1))
    def metric(model, data):
        ranks = []
        with torch.no_grad():
            for r in data['rows']:
                x = features(r)
                pred = model(x).reshape(-1)
                order = torch.argsort(pred, descending=True, stable=True).tolist()
                ranks.append(1+min(order.index(h) for h in r['hit']))
        return {'placements': data['n_placements'], 'legal_hits': len(ranks),
                'top1': sum(r == 1 for r in ranks), 'top5': sum(r <= 5 for r in ranks),
                'median_rank': float(np.median(ranks)) if ranks else None}
    results = {'features': names, 'vlm_hint_features': False, 'runtime_vlm_calls': 0,
               'scope': 'historical truth-state, oracle part identity, permissive target labels; NOT production accuracy',
               'folds': []}
    class Baseline(nn.Module):
        def forward(self, x):
            return x[:,0] + .35*x[:,1] + .15*x[:,2]
    for train_sn, test_sn in [('3931', '41624'), ('41624', '3931')]:
        train, test = caches[train_sn], caches[test_sn]
        fold = {'train_set': train_sn, 'test_set': test_sn, 'baseline': metric(Baseline(), test)}
        for kind in ['linear', 'mlp']:
            torch.manual_seed(743)
            model = (nn.Linear(len(names), 1) if kind == 'linear' else
                     nn.Sequential(nn.Linear(len(names), 24), nn.Tanh(), nn.Linear(24, 1)))
            opt = torch.optim.AdamW(model.parameters(), lr=.01, weight_decay=.1)
            for epoch in range(150):
                loss = 0
                for row in train['rows']:
                    pred = model(features(row)).flatten()
                    loss = loss + torch.logsumexp(pred, 0)-torch.logsumexp(pred[row['hit']], 0)
                loss = loss / len(train['rows'])
                opt.zero_grad()
                loss.backward()
                opt.step()
            fold[kind] = {'train': metric(model, train), 'heldout': metric(model, test)}
        results['folds'].append(fold)
    OUT.mkdir(exist_ok=True, parents=True)
    (OUT / 'placement-rank-results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
