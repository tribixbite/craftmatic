"""Resolve universal CAD files and explicit aliases from their own headers.

No set model, inventory or pose information is consulted. Cached public part
files are data, never executable code. Missing geometry remains an error.
"""
import hashlib
from pathlib import Path
import re
import sys


class PartLibrary:
    def __init__(self,cache='C:/git/craftmatic/output/pdf-universal-parts'):
        self.cache=Path(cache)
        self.aliases={};self.files={};self.provenance={}
        for path in sorted(self.cache.glob('*.dat')):
            payload=path.read_bytes();content=payload.decode('utf-8',errors='replace')
            if not content.startswith('0 '):raise ValueError(f'Not an LDraw part: {path.name}')
            self.files[path.name.lower()]=path
            keys=[]
            for line in content.splitlines():
                if line.startswith('0 !KEYWORDS'):
                    keys.extend(re.findall(r'\bBrickLink\s+([A-Za-z0-9_-]+)',line,re.I))
            for alias in keys:
                name=alias.lower()+'.dat'
                if name in self.aliases and self.aliases[name]!=path:raise ValueError(f'Ambiguous universal alias: {alias}')
                self.aliases[name]=path
            self.provenance[path.name]={'sha256':hashlib.sha256(payload).hexdigest(),
                'bricklink_aliases':keys,'alias_evidence':'LDraw part !KEYWORDS header',
                'canonical_upstream_url':'https://library.ldraw.org/library/official/parts/'+path.name}

    def resolve(self,name):
        key=str(name).replace('\\','/').lower()
        if not key.endswith('.dat'):key+='.dat'
        if key.startswith('/') or '..' in key.split('/') or ':' in key:raise ValueError('Invalid part path')
        if key in self.aliases:return self.aliases[key]
        if key in self.files:return self.files[key]
        sys.path.insert(0,'C:/git/clego')
        from dbix_settle import SEARCH
        # Preserve s/, 8/ and 48/ references. The legacy lookup discards all
        # directories, which can silently substitute a different primitive.
        for root in SEARCH:
            path=Path(root)/key
            if path.is_file():return path
        raise FileNotFoundError(f'Universal CAD unavailable: {name}')
