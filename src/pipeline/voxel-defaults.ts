/**
 * Voxelizer default constants — a dependency-free leaf module.
 *
 * These live here, NOT in `pipeline.ts`, so that browser-reachable code
 * (`browser-entry.ts`, `synthesis/sliced-tiles.ts`) can import them without
 * dragging in `pipeline.ts`'s headless-only graph. `pipeline.ts` statically
 * imports `capture/tiles.ts` → `tiles-deps.ts` → `node:path`, which vite
 * externalizes for the browser; importing it from client code throws
 * "Module node:path has been externalized" at module-eval time and breaks the
 * whole app. Keeping the shared constants in a leaf module severs that chain.
 */

/** Default voxelizer resolution in blocks per metre for print/voxel export. */
export const DEFAULT_VOXEL_RESOLUTION = 6;

/** Default cap on any grid axis (voxels) to bound memory on tall/large buildings. */
export const DEFAULT_VOXEL_MAX_DIMENSION = 768;
