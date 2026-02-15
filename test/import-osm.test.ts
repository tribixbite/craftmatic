import { describe, it, expect } from 'vitest';
import {
  haversineDistance,
  polygonBoundingDimensions,
  mapOSMMaterialToWall,
  mapOSMRoofShape,
  parseClosestBuilding,
  type OverpassElement,
} from '../web/src/ui/import-osm.js';

describe('haversineDistance', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistance(40, -74, 40, -74)).toBe(0);
  });

  it('calculates roughly correct distance between known points', () => {
    // NYC to Philadelphia ≈ 130 km
    const dist = haversineDistance(40.7128, -74.0060, 39.9526, -75.1652);
    expect(dist).toBeGreaterThan(125000);
    expect(dist).toBeLessThan(135000);
  });

  it('calculates short distances accurately', () => {
    // ~111m for 0.001 degrees latitude at equator
    const dist = haversineDistance(0, 0, 0.001, 0);
    expect(dist).toBeGreaterThan(100);
    expect(dist).toBeLessThan(120);
  });
});

describe('polygonBoundingDimensions', () => {
  it('returns 0 for degenerate polygon', () => {
    const result = polygonBoundingDimensions([{ lat: 40, lon: -74 }]);
    expect(result.widthMeters).toBe(0);
    expect(result.lengthMeters).toBe(0);
  });

  it('computes roughly correct dimensions for a rectangular building', () => {
    // ~10m x ~20m rectangle near NYC
    const polygon = [
      { lat: 40.7128, lon: -74.0060 },
      { lat: 40.7128, lon: -74.00575 },  // ~21m east
      { lat: 40.71289, lon: -74.00575 }, // ~10m north
      { lat: 40.71289, lon: -74.0060 },
    ];
    const { widthMeters, lengthMeters } = polygonBoundingDimensions(polygon);

    // Width (shorter) should be ~10m, length (longer) should be ~21m
    expect(widthMeters).toBeGreaterThan(5);
    expect(widthMeters).toBeLessThan(20);
    expect(lengthMeters).toBeGreaterThan(15);
    expect(lengthMeters).toBeLessThan(30);
    // Length should be >= width (convention)
    expect(lengthMeters).toBeGreaterThanOrEqual(widthMeters);
  });
});

describe('mapOSMMaterialToWall', () => {
  it('maps "brick" to minecraft:bricks', () => {
    expect(mapOSMMaterialToWall('brick')).toBe('minecraft:bricks');
  });

  it('maps "stone" to minecraft:stone_bricks', () => {
    expect(mapOSMMaterialToWall('stone')).toBe('minecraft:stone_bricks');
  });

  it('maps "concrete" to minecraft:white_concrete', () => {
    expect(mapOSMMaterialToWall('concrete')).toBe('minecraft:white_concrete');
  });

  it('maps "wood" to minecraft:oak_planks', () => {
    expect(mapOSMMaterialToWall('wood')).toBe('minecraft:oak_planks');
  });

  it('maps "timber" to minecraft:oak_planks', () => {
    expect(mapOSMMaterialToWall('timber')).toBe('minecraft:oak_planks');
  });

  it('maps "log" to minecraft:spruce_planks', () => {
    expect(mapOSMMaterialToWall('log')).toBe('minecraft:spruce_planks');
  });

  it('maps "metal" to minecraft:iron_block', () => {
    expect(mapOSMMaterialToWall('metal')).toBe('minecraft:iron_block');
  });

  it('maps "glass" to minecraft:white_stained_glass', () => {
    expect(mapOSMMaterialToWall('glass')).toBe('minecraft:white_stained_glass');
  });

  it('maps "sandstone" to minecraft:sandstone', () => {
    expect(mapOSMMaterialToWall('sandstone')).toBe('minecraft:sandstone');
  });

  it('maps "adobe" to minecraft:terracotta', () => {
    expect(mapOSMMaterialToWall('adobe')).toBe('minecraft:terracotta');
  });

  it('maps "plaster" to minecraft:white_concrete', () => {
    expect(mapOSMMaterialToWall('plaster')).toBe('minecraft:white_concrete');
  });

  it('is case-insensitive', () => {
    expect(mapOSMMaterialToWall('BRICK')).toBe('minecraft:bricks');
    expect(mapOSMMaterialToWall('Concrete')).toBe('minecraft:white_concrete');
  });

  it('returns undefined for unknown materials', () => {
    expect(mapOSMMaterialToWall('unknown')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(mapOSMMaterialToWall('')).toBeUndefined();
  });
});

describe('mapOSMRoofShape', () => {
  it('normalizes common roof shapes', () => {
    expect(mapOSMRoofShape('gabled')).toBe('Gable');
    expect(mapOSMRoofShape('gable')).toBe('Gable');
    expect(mapOSMRoofShape('hipped')).toBe('Hip');
    expect(mapOSMRoofShape('flat')).toBe('Flat');
    expect(mapOSMRoofShape('gambrel')).toBe('Gambrel');
    expect(mapOSMRoofShape('mansard')).toBe('Mansard');
  });

  it('capitalizes unknown shapes as fallback', () => {
    expect(mapOSMRoofShape('butterfly')).toBe('Butterfly');
  });

  it('returns empty string for empty input', () => {
    expect(mapOSMRoofShape('')).toBe('');
  });
});

describe('parseClosestBuilding', () => {
  it('returns null for empty elements array', () => {
    expect(parseClosestBuilding([], 40, -74)).toBeNull();
  });

  it('returns null when no ways have geometry', () => {
    const elements: OverpassElement[] = [
      { type: 'node', id: 1 },
      { type: 'way', id: 2 },
    ];
    expect(parseClosestBuilding(elements, 40, -74)).toBeNull();
  });

  it('parses a single building correctly', () => {
    const polygon = [
      { lat: 40.7128, lon: -74.0060 },
      { lat: 40.7128, lon: -74.0058 },
      { lat: 40.7130, lon: -74.0058 },
      { lat: 40.7130, lon: -74.0060 },
    ];
    const elements: OverpassElement[] = [{
      type: 'way',
      id: 100,
      geometry: polygon,
      tags: {
        'building': 'yes',
        'building:levels': '2',
        'building:material': 'brick',
        'roof:shape': 'gabled',
      },
    }];

    const result = parseClosestBuilding(elements, 40.7129, -74.0059);
    expect(result).not.toBeNull();
    expect(result!.polygon).toHaveLength(4);
    expect(result!.widthMeters).toBeGreaterThan(0);
    expect(result!.lengthMeters).toBeGreaterThan(0);
    expect(result!.widthBlocks).toBeGreaterThanOrEqual(6);
    expect(result!.lengthBlocks).toBeGreaterThanOrEqual(6);
    expect(result!.levels).toBe(2);
    expect(result!.material).toBe('brick');
    expect(result!.roofShape).toBe('gabled');
  });

  it('picks the closest building when multiple are present', () => {
    const nearBuilding: OverpassElement = {
      type: 'way',
      id: 1,
      geometry: [
        { lat: 40.7128, lon: -74.0060 },
        { lat: 40.7128, lon: -74.0058 },
        { lat: 40.7130, lon: -74.0058 },
      ],
      tags: { building: 'yes', 'building:material': 'stone' },
    };
    const farBuilding: OverpassElement = {
      type: 'way',
      id: 2,
      geometry: [
        { lat: 40.7200, lon: -74.0100 },
        { lat: 40.7200, lon: -74.0098 },
        { lat: 40.7202, lon: -74.0098 },
      ],
      tags: { building: 'yes', 'building:material': 'wood' },
    };

    // Query near the first building
    const result = parseClosestBuilding([nearBuilding, farBuilding], 40.7129, -74.0059);
    expect(result).not.toBeNull();
    expect(result!.material).toBe('stone');
  });

  it('handles building:colour tag', () => {
    const elements: OverpassElement[] = [{
      type: 'way',
      id: 1,
      geometry: [
        { lat: 40.7128, lon: -74.0060 },
        { lat: 40.7128, lon: -74.0058 },
        { lat: 40.7130, lon: -74.0058 },
      ],
      tags: { building: 'yes', 'building:colour': '#aabbcc', 'roof:colour': 'brown' },
    }];

    const result = parseClosestBuilding(elements, 40.7129, -74.0059);
    expect(result!.buildingColour).toBe('#AABBCC');
    expect(result!.roofColour).toBe('#8B4513');
  });

  it('expands shorthand hex colours', () => {
    const elements: OverpassElement[] = [{
      type: 'way',
      id: 1,
      geometry: [
        { lat: 40, lon: -74 },
        { lat: 40.001, lon: -74 },
        { lat: 40.001, lon: -73.999 },
      ],
      tags: { building: 'yes', 'building:colour': '#abc' },
    }];

    const result = parseClosestBuilding(elements, 40.0005, -73.9995);
    expect(result!.buildingColour).toBe('#AABBCC');
  });
});
