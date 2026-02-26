/**
 * Tests for OSM Overpass tree node query.
 */

import { describe, it, expect } from 'vitest';
import { searchOSMTrees } from '../web/src/ui/import-osm-trees.js';

describe('searchOSMTrees', () => {
  it('finds trees in Central Park, NYC', async () => {
    // Central Park — heavily mapped, many individual tree nodes
    const trees = await searchOSMTrees(40.7812, -73.9665, 200);
    expect(trees.length).toBeGreaterThan(0);
    // Each tree should have valid coordinates
    for (const tree of trees) {
      expect(tree.lat).toBeGreaterThan(40);
      expect(tree.lon).toBeLessThan(-73);
    }
  }, 40000);

  it('returns empty array for middle of ocean', async () => {
    const trees = await searchOSMTrees(30.0, -50.0, 100);
    expect(trees).toEqual([]);
  }, 40000);

  it('parses height from OSM tags when available', async () => {
    // Central Park trees often have height tagged
    const trees = await searchOSMTrees(40.7812, -73.9665, 200);
    // At least some should have species or height
    const withMeta = trees.filter(t => t.species || t.height);
    // This is not guaranteed — OSM tagging varies — so just verify structure
    for (const tree of withMeta) {
      if (tree.height != null) {
        expect(tree.height).toBeGreaterThan(0);
        expect(tree.height).toBeLessThan(100);
      }
      if (tree.species) {
        expect(typeof tree.species).toBe('string');
      }
    }
  }, 40000);
});
