"""Bounded joint selection from fixed, registered CAD depth layers.

Exact cardinality and pairwise collision exclusions. Upper bounds ignore future
occlusion and false positives, so remain optimistic. No intermediate image beam
pruning. Node-budget exhaustion is explicitly incomplete. Candidate-generation,
registration and physical interlocking validation remain caller responsibilities.
"""
from collections import Counter
import numpy as np


def search_layers(base_depth,base_labels,depths,labels,colors,quotas,target,
                  conflicts=(),base_supported=None,support_edges=(),max_nodes=100000,conflict_test=None,priorities=None,top_k=1):
    depths=np.asarray(depths);labels=np.asarray(labels);target=np.asarray(target)
    n=len(depths);colors=list(colors);quotas=dict(quotas)
    if top_k<1 or int(top_k)!=top_k:raise ValueError('top_k must be a positive integer')
    if max_nodes<1 or int(max_nodes)!=max_nodes:raise ValueError('max_nodes must be a positive integer')
    if np.asarray(base_depth).shape!=target.shape or np.asarray(base_labels).shape!=target.shape:raise ValueError('Base dimensions mismatch')
    if depths.shape!=labels.shape or depths.shape[1:]!=target.shape:raise ValueError('Layer dimensions mismatch')
    if len(colors)!=n or any(int(v)!=v or v<0 for v in quotas.values()):raise ValueError('Invalid cardinalities')
    if any(c not in quotas for c in colors):raise ValueError('Candidate color missing quota')
    if priorities is not None and (len(priorities)!=n or not np.isfinite(priorities).all()):raise ValueError('Invalid priorities')
    if np.isnan(depths).any() or np.isnan(base_depth).any() or np.isposinf(depths).any() or np.isposinf(base_depth).any():raise ValueError('Depth must be finite or negative infinity')
    if np.any((labels>0)&~np.isfinite(depths)) or np.any((np.asarray(base_labels)>0)&~np.isfinite(base_depth)):raise ValueError('Material labels require occupied finite depth')
    blocked=[set() for _ in range(n)];support=[set() for _ in range(n)]
    for collection,graph in ((conflicts,blocked),(support_edges,support)):
        for a,b in collection:
            if not 0<=a<n or not 0<=b<n or a==b:raise ValueError('Graph edge outside candidate bank or self edge')
            graph[a].add(b);graph[b].add(a)
    anchored=set(range(n)) if base_supported is None else set(base_supported)
    if any(not 0<=i<n for i in anchored):raise ValueError('Invalid base support index')
    classes=[int(c) for c in np.unique(target) if c>0]
    if not classes:raise ValueError('Target has no scored material classes')
    areas={c:int(np.sum(target==c)) for c in classes}
    # Search minority color first; this changes traversal, never admissible states.
    order=sorted(range(n),key=lambda i:(quotas[colors[i]],str(colors[i]),-float(priorities[i]) if priorities is not None else 0,i))
    def correct_bits(layer,c):
        return int.from_bytes(np.packbits((target==c)&(layer==c)).tobytes(),'little')
    base_bits=[correct_bits(np.asarray(base_labels),c) for c in classes]
    layer_bits=[[correct_bits(labels[i],c) for c in classes] for i in range(n)]
    suffix=[[0]*len(classes) for _ in range(n+1)];rank={i:k for k,i in enumerate(order)}
    for k in range(n-1,-1,-1):suffix[k]=[a|b for a,b in zip(layer_bits[order[k]],suffix[k+1])]
    nodes=0;pruned=0;leaves=0;best=-1.;winner=None;exhausted=False;retained=[]
    def composite(chosen):
        d=np.asarray(base_depth).copy();l=np.asarray(base_labels).copy()
        for i in sorted(chosen):
            take=np.isfinite(depths[i])&(depths[i]>=d)
            d[take]=depths[i][take];l[take]=labels[i][take]
        return d,l
    def metric(l):
        return float(np.mean([np.sum((target==c)&(l==c))/max(1,np.sum((target==c)|(l==c))) for c in classes]))
    def bound(chosen,remaining):
        # Any final correctly labeled pixel must occur in at least one selected
        # or still-available source layer, regardless of depth/occlusion.
        possible=base_bits.copy()
        for i in chosen:possible=[a|b for a,b in zip(possible,layer_bits[i])]
        # Suffix deliberately includes conflict-excluded candidates: weaker but
        # still admissible, without rebuilding images or O(n) unions per node.
        future=suffix[rank[remaining[0]]] if remaining else suffix[n]
        return float(np.mean([(a|b).bit_count()/areas[c] for a,b,c in zip(possible,future,classes)]))
    def connected(chosen):
        wanted=set(chosen);seen=wanted&anchored;todo=list(seen)
        while todo:
            fresh=(support[todo.pop()]&wanted)-seen;seen.update(fresh);todo.extend(fresh)
        return seen==wanted
    stack=[((),order,Counter())]
    while stack:
        if nodes>=max_nodes:exhausted=True;break
        chosen,remaining,counts=stack.pop()
        nodes+=1
        if all(counts[c]==q for c,q in quotas.items()):
            if not connected(chosen):continue
            leaves+=1;_,l=composite(chosen);value=metric(l)
            if value>best:best=value;winner=tuple(sorted(chosen))
            retained.append(dict(indices=tuple(sorted(chosen)),score=value))
            retained.sort(key=lambda r:(-r['score'],r['indices']));del retained[top_k:]
            continue
        avail=Counter(colors[i] for i in remaining)
        if any(counts[c]+avail[c]<q for c,q in quotas.items()):pruned+=1;continue
        threshold=retained[-1]['score'] if len(retained)>=top_k else -1.
        if bound(chosen,remaining)<threshold-1e-12:pruned+=1;continue
        if not remaining:continue
        i=remaining[0];rest=remaining[1:];color=colors[i]
        stack.append((chosen,rest,counts))
        if counts[color]<quotas[color]:
            nextcounts=counts.copy();nextcounts[color]+=1
            if conflict_test is None or all(not conflict_test(i,j) for j in chosen):
                stack.append((chosen+(i,),[j for j in rest if j not in blocked[i]],nextcounts))
    return dict(indices=winner,score=best if winner is not None else None,candidates=retained,top_k=top_k,nodes=nodes,
                pruned=pruned,complete_leaves=leaves,search_exhaustive=not exhausted,
                node_budget=max_nodes,truth_used=False,certified=False,
                limitations='Optimal only within supplied registered finite layers if exhaustive; collision conflict graph and connector reachability supplied externally. No continuous camera or candidate-recall guarantee.')
