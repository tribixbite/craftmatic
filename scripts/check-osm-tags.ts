#!/usr/bin/env bun
import { searchOSMBuilding } from '../src/gen/api/osm.js';
const buildings = [
  { name: 'noe',       lat: 37.7604, lng: -122.4314 },
  { name: 'green',     lat: 37.7954, lng: -122.4332 },
  { name: 'francisco', lat: 37.8005, lng: -122.4382 },
  { name: 'beach',     lat: 37.8031, lng: -122.4397 },
  { name: 'chestnut',  lat: 37.8007, lng: -122.4378 },
  { name: 'dakota',    lat: 40.7766, lng: -73.9762 },
  { name: 'sentinel',  lat: 37.7978, lng: -122.4068 },
];
for (const b of buildings) {
  try {
    const osm = await searchOSMBuilding(b.lat, b.lng, 100);
    if (!osm) { console.log(`${b.name}: no OSM data`); continue; }
    const { material, roofShape, roofMaterial, buildingColour, roofColour, levels, tags } = osm;
    console.log(`${b.name}: material=${material||'-'} roofMat=${roofMaterial||'-'} roofShape=${roofShape||'-'} bldgColor=${buildingColour||'-'} roofColor=${roofColour||'-'} levels=${levels||'-'}`);
    console.log(`  tags: ${JSON.stringify(tags)}`);
  } catch (e) { console.log(`${b.name}: error ${(e as Error).message}`); }
}
