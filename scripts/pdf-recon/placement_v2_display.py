"""Keep final assembly pose separate from the state depicted in an exploded step.

The legacy runtime bank appends arrow-attached instances after image-judged
instances. This adapter verifies that provenance instead of scoring the final
assembly against an earlier drawing. No reference or hand-labeled poses.
"""
import numpy as np


def partition_display(items, row):
    count = row.get('attached_pieces', 0)
    if not isinstance(count, int) or count < 0 or count >= len(items):
        raise ValueError('Invalid appended attachment count')
    if not count:
        return list(items), [], dict(drawn_count=len(items), attached_count=0)
    record = row.get('arrow_attachment') or {}
    steps = record.get('steps') or []
    if record.get('status') != 'placed' or len(steps) != count:
        raise ValueError('Appended pieces lack successful arrow attachment provenance')
    drawn, detached = list(items[:-count]), list(items[-count:])
    for (part, color, transform), step in zip(detached, steps):
        if (str(part) != str(step.get('part')) or int(color) != step.get('color')
                or step.get('status') != 'placed'
                or not np.allclose(np.asarray(transform)[:3, 3], step.get('translation'), atol=1e-5, rtol=0)):
            raise ValueError('Appended instance disagrees with recorded attachment')
    return drawn, detached, dict(drawn_count=len(drawn), attached_count=count,
                                 protocol='Verified runtime appended-instance provenance; final pose retained')
