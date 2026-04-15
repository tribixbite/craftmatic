/**
 * File upload UI — drag-and-drop parsing for .schem, .litematic, and mesh files.
 *
 * Mesh files (GLB/GLTF/OBJ) are loaded and returned as raw Object3D for
 * immediate rendering. Voxelization is deferred — triggered by user action.
 */

import * as THREE from 'three';
import { parseSchemFile } from '@engine/schem.js';
import { BlockGrid } from '@craft/schem/types.js';
import type { MeshInfo } from '@engine/mesh-import.js';

/** Supported file extensions */
const SUPPORTED_EXTENSIONS = ['schem', 'schematic', 'nbt', 'litematic', 'glb', 'gltf', 'obj'];

/** Mesh format extensions (loaded by mesh-import.ts) */
const MESH_EXTENSIONS = ['glb', 'gltf', 'obj'];

/** Mesh upload result — raw Object3D with metadata for deferred voxelization */
export interface MeshUploadResult {
  object: THREE.Object3D;
  info: MeshInfo;
  bytes: ArrayBuffer;
  filename: string;
}

/** Discriminated union for upload results */
export type UploadResult =
  | { type: 'schematic'; grid: BlockGrid; filename: string }
  | { type: 'mesh'; result: MeshUploadResult };

/** Initialize upload zone with drag-and-drop and click-to-browse */
export function initUpload(
  zoneEl: HTMLElement,
  fileInput: HTMLInputElement,
  infoEl: HTMLElement,
  onResult: (result: UploadResult) => void,
): void {
  // Click to browse
  zoneEl.addEventListener('click', () => fileInput.click());

  // Drag events
  zoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    zoneEl.classList.add('dragover');
  });

  zoneEl.addEventListener('dragleave', () => {
    zoneEl.classList.remove('dragover');
  });

  zoneEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    zoneEl.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (file) await handleFile(file);
  });

  // File input change
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) await handleFile(file);
    fileInput.value = '';
  });

  // Auto-load from ?file= URL parameter (bypasses file picker for testing)
  const fileParam = new URLSearchParams(window.location.search).get('file');
  if (fileParam) {
    fetch(fileParam)
      .then(r => r.blob())
      .then(blob => handleFile(new File([blob], fileParam.split('/').pop() ?? 'auto.schem')))
      .catch(err => console.error('[upload] auto-load failed:', err));
  }

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

  // Generation counter to detect stale uploads (user drops new file during processing)
  let uploadGeneration = 0;

  async function handleFile(file: File): Promise<void> {
    const myGen = ++uploadGeneration;
    const uploadText = zoneEl.querySelector('.upload-text') as HTMLElement;
    const uploadSubtext = zoneEl.querySelector('.upload-subtext') as HTMLElement;

    // Validate file extension
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !SUPPORTED_EXTENSIONS.includes(ext)) {
      uploadText.textContent = 'Unsupported file type';
      uploadSubtext.textContent = `Supported: ${SUPPORTED_EXTENSIONS.map(e => '.' + e).join(', ')}`;
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      uploadText.textContent = 'File too large';
      uploadSubtext.textContent = `Maximum size is ${formatSize(MAX_FILE_SIZE)}, got ${formatSize(file.size)}`;
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      if (myGen !== uploadGeneration) return; // stale — user dropped another file

      const safeName = escapeHtml(file.name);

      if (MESH_EXTENSIONS.includes(ext)) {
        // Mesh format — load Object3D for immediate rendering (no voxelization)
        uploadText.textContent = 'Loading mesh...';
        uploadSubtext.textContent = file.name;
        const { loadMeshFromBytes, analyzeMesh } = await import('@engine/mesh-import.js');
        const object = await loadMeshFromBytes(buffer, file.name);
        if (myGen !== uploadGeneration) return;
        const info = analyzeMesh(object);

        // Show mesh info
        const { boundingBox: bb } = info;
        infoEl.hidden = false;
        infoEl.innerHTML = `
          <div class="info-row"><span class="info-label">File</span><span class="info-value">${safeName}</span></div>
          <div class="info-row"><span class="info-label">Size</span><span class="info-value">${formatSize(file.size)}</span></div>
          <div class="info-row"><span class="info-label">Extent</span><span class="info-value">${bb.width.toFixed(1)} x ${bb.height.toFixed(1)} x ${bb.depth.toFixed(1)}m</span></div>
          <div class="info-row"><span class="info-label">Triangles</span><span class="info-value">${info.triangleCount.toLocaleString()}</span></div>
          <div class="info-row"><span class="info-label">Meshes</span><span class="info-value">${info.meshCount}</span></div>
          <div class="info-row"><span class="info-label">Textured</span><span class="info-value">${info.hasTextures ? 'Yes' : 'No'}</span></div>
        `;

        uploadText.innerHTML = `Loaded <code>${safeName}</code>`;
        uploadSubtext.textContent = 'Drop another file to replace';

        onResult({ type: 'mesh', result: { object, info, bytes: buffer, filename: file.name } });
      } else {
        // Schematic format (schem, litematic, nbt)
        let grid: BlockGrid;

        if (ext === 'litematic') {
          uploadText.textContent = 'Parsing .litematic...';
          uploadSubtext.textContent = file.name;
          const { parseLitematicFile } = await import('@engine/litematic.js');
          grid = await parseLitematicFile(buffer);
        } else {
          uploadText.textContent = 'Parsing...';
          uploadSubtext.textContent = file.name;
          grid = await parseSchemFile(buffer);
        }

        if (myGen !== uploadGeneration) return;

        const nonAir = grid.countNonAir();
        infoEl.hidden = false;
        infoEl.innerHTML = `
          <div class="info-row"><span class="info-label">File</span><span class="info-value">${safeName}</span></div>
          <div class="info-row"><span class="info-label">Size</span><span class="info-value">${formatSize(file.size)}</span></div>
          <div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${grid.width} x ${grid.height} x ${grid.length}</span></div>
          <div class="info-row"><span class="info-label">Blocks</span><span class="info-value">${nonAir.toLocaleString()}</span></div>
          <div class="info-row"><span class="info-label">Palette</span><span class="info-value">${grid.palette.size} materials</span></div>
          <div class="info-row"><span class="info-label">Entities</span><span class="info-value">${grid.blockEntities.length}</span></div>
        `;

        uploadText.innerHTML = `Loaded <code>${safeName}</code>`;
        uploadSubtext.textContent = 'Drop another file to replace';

        onResult({ type: 'schematic', grid, filename: file.name });
      }
    } catch (err) {
      if (myGen !== uploadGeneration) return;
      uploadText.textContent = 'Failed to parse file';
      uploadSubtext.textContent = String(err);
      console.error('File parse error:', err);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
