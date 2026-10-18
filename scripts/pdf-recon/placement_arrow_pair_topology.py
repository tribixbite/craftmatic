"""Select exactly two arrow-linked components, retaining unexplained leftovers."""
import numpy as np


def arrow_pair_components(graph):
    components=graph['components'];pairs=[];evidence=[]
    if not graph['arrows']:raise ValueError('No accepted arrow topology')
    for arrow in graph['arrows']:
        endpoints=[]
        for name in ('tail','head'):
            point=np.asarray(arrow[name]);distances=[]
            for index,c in enumerate(components):
                y,x=np.nonzero(c['mask']);distance=float(np.min(np.hypot(x-point[0],y-point[1])))
                distances.append((distance,index))
            if not distances:raise ValueError('No part components')
            nearest=min(d for d,i in distances)
            eligible=[i for d,i in distances if d<=nearest+2]
            selected=max(eligible,key=lambda i:components[i]['area'])
            endpoints.append(selected);evidence.append(dict(endpoint=name,component=selected,distance_px=next(d for d,i in distances if i==selected)))
        if endpoints[0]==endpoints[1]:raise ValueError('Arrow does not connect two distinct components')
        pairs.append(tuple(endpoints))
    if len(set(pairs))!=1:raise ValueError('Accepted arrows disagree on component topology')
    tail,head=pairs[0]
    return [components[head],components[tail]],dict(original_head_component=head,original_tail_component=tail,ignored_components=[i for i in range(len(components)) if i not in (head,tail)],endpoint_evidence=evidence)
