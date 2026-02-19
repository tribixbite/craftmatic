/**
 * Block mesh conversion — transforms BlockGrid data into
 * Three.js geometries using instanced rendering.
 *
 * Texture atlas UV mapping is handled by texture-atlas.ts.
 * Greedy meshing for adjacent same-material faces is a future optimization.
 */

// Re-export the scene builder which handles mesh creation
export { buildScene, serializeForViewer } from './three-scene.js';
