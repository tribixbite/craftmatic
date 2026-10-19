import { describe, it, expect } from 'vitest';
import {
  parseClosestBuilding as pipelineSelect,
  isAuxiliaryStructure,
  type OverpassElement,
} from '../src/gen/api/osm.js';
import { parseClosestBuilding as browserSelect } from '../web/src/ui/import-osm.js';

// Square way ~WxW metres centred at (lat, lon), with tags.
function way(id: number, lat: number, lon: number, wM: number, tags: Record<string, string>): OverpassElement {
  const d = (wM / 2) / 111_111;
  return {
    type: 'way', id, tags,
    geometry: [
      { lat: lat - d, lon: lon - d }, { lat: lat - d, lon: lon + d },
      { lat: lat + d, lon: lon + d }, { lat: lat + d, lon: lon - d },
      { lat: lat - d, lon: lon - d },
    ],
  } as unknown as OverpassElement;
}

// The Berwyn regression, distilled: an interpolated pin at origin, a park
// toilet block 53m east, the real house 59m west.
const PIN = { lat: 0, lon: 0 };
const M = 1 / 111_111;
const toilet = way(1, 0, 53 * M, 10, { building: 'yes', amenity: 'toilets' });
const house = way(2, 0, -59 * M, 12, { building: 'house' });

describe('isAuxiliaryStructure', () => {
  it('flags toilets/garages/sheds via building= and amenity=', () => {
    expect(isAuxiliaryStructure({ building: 'yes', amenity: 'toilets' })).toBe(true);
    expect(isAuxiliaryStructure({ building: 'garage' })).toBe(true);
    expect(isAuxiliaryStructure({ building: 'shed' })).toBe(true);
    expect(isAuxiliaryStructure({ building: 'house' })).toBe(false);
    expect(isAuxiliaryStructure({ building: 'yes', amenity: 'place_of_worship' })).toBe(false);
    expect(isAuxiliaryStructure(undefined)).toBe(false);
  });
});

describe('pipeline parseClosestBuilding plausibility', () => {
  it('prefers the farther PRINCIPAL building over a nearer toilet block', () => {
    const r = pipelineSelect([toilet, house], PIN.lat, PIN.lon);
    expect(r).not.toBeNull();
    expect(r!.tags['building']).toBe('house');
  });

  it('still returns the auxiliary structure when it is the only candidate', () => {
    const r = pipelineSelect([toilet], PIN.lat, PIN.lon);
    expect(r).not.toBeNull();
    expect(r!.tags['amenity']).toBe('toilets');
  });

  it('an exact addr:housenumber match beats a nearer unaddressed building', () => {
    const unaddressed = way(3, 0, 20 * M, 12, { building: 'house' });
    const addressed = way(4, 0, -80 * M, 12, { building: 'house', 'addr:housenumber': '1123' });
    const r = pipelineSelect([unaddressed, addressed], PIN.lat, PIN.lon, '1123');
    expect(r!.tags['addr:housenumber']).toBe('1123');
  });

  it('a non-matching housenumber only gets the small addressed bonus', () => {
    const near = way(5, 0, 20 * M, 12, { building: 'house' });
    const farWrongNumber = way(6, 0, -80 * M, 12, { building: 'house', 'addr:housenumber': '999' });
    const r = pipelineSelect([near, farWrongNumber], PIN.lat, PIN.lon, '1123');
    expect(r!.tags['addr:housenumber']).toBeUndefined();
  });

  it('a containing principal building still wins outright', () => {
    const containing = way(7, 0, 0, 30, { building: 'retail' });
    const r = pipelineSelect([toilet, containing], PIN.lat, PIN.lon);
    expect(r!.tags['building']).toBe('retail');
  });
});

describe('browser parseClosestBuilding plausibility (mirrored)', () => {
  it('prefers the farther principal building over a nearer toilet block', () => {
    const r = browserSelect(
      [toilet, house] as unknown as Parameters<typeof browserSelect>[0],
      PIN.lat, PIN.lon,
    );
    expect(r).not.toBeNull();
    expect(r!.tags['building']).toBe('house');
  });
});
