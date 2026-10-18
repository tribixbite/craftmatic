"""Validate optional identity/color/quantity input without accepting pose data."""
from collections import Counter
import hashlib
import json
from pathlib import Path


def load_parts_list(path):
    path=Path(path)
    payload=path.read_bytes()
    records=json.loads(payload)
    if isinstance(records,dict):
        if set(records)!={'records'}:raise ValueError('Parts list object must contain only records')
        records=records['records']
    if not isinstance(records,list) or not records:raise ValueError('Parts list must be a nonempty array')
    counts=Counter()
    for record in records:
        if not isinstance(record,dict) or set(record)!={'part','color','qty'}:
            raise ValueError('Each parts list record requires only part, color, qty; poses are forbidden')
        part=record['part']
        if not isinstance(part,str) or not part or any(c in part for c in '/\\\r\n\t '):
            raise ValueError('Invalid universal part identifier')
        color=record['color'];qty=record['qty']
        if type(color) is not int or color<0 or type(qty) is not int or qty<=0:
            raise ValueError('Color must be a nonnegative integer and quantity a positive integer')
        counts[(part.removesuffix('.dat'),color)]+=qty
    return {'records':[dict(part=p,color=c,qty=n) for (p,c),n in sorted(counts.items())],
            'source':str(path.resolve()),'sha256':hashlib.sha256(payload).hexdigest(),
            'scope':'Optional supplied inventory only; no poses or step assignments'}
