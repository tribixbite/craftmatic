"""Universal geometry with complete dependency checks and no shape fallback."""
import sys
import numpy as np
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary


class StrictGeometry:
    def __init__(self,library=None):
        self.library=library or PartLibrary()
        self.cache={}

    def load(self,part):
        if part not in self.cache:
            parsed=colored_triangles(part,16,resolver=self.library.resolve)
            sys.path.insert(0,'C:/git/clego')
            from dbix_settle import _sample_tris
            points=np.asarray(_sample_tris(parsed['triangles']),np.float32)
            if not len(points):raise ValueError(f'No real surface samples: {part}')
            self.cache[part]={'triangles':parsed['triangles'],'points':points,'files':parsed['files']}
        return self.cache[part]

    def provenance(self):
        return {part:value['files'] for part,value in self.cache.items()}
