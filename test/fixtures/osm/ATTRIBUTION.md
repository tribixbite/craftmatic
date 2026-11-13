# OSM test fixtures

`notre-dame.overpass.json` and `louvre-palace.overpass.json` are Overpass API responses (`out geom;`) fetched on
2026-11-09 from overpass-api.de with one polite request each. The Louvre file keeps only relation 3262297 and the
Notre-Dame file only its ways (neighbouring relations dropped); no element was edited.

Data (c) OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0):
https://www.openstreetmap.org/copyright

`cologne-spires.overpass.json` (spire package, 2026-11-12): one Overpass request (`way[building]` and `way["building:part"]` within 90 m of 50.9413, 6.958, `out geom;`) from overpass-api.de; only the cathedral way (4532022) and the `building:part` ways are kept, none edited. Same ODbL attribution.
