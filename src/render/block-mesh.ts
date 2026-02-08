/**
 * Block mesh conversion — transforms BlockGrid data into
 * Three.js geometries using instanced rendering.
 *
 * TODO: Implement greedy meshing for adjacent same-material faces
 * TODO: Add texture atlas UV mapping
 */

// Re-export the scene builder which handles mesh creation
export { buildScene, serializeForViewer } from './three-scene.js';
