/**
 * File upload UI — drag-and-drop .schem file parsing.
 */

import { parseSchemFile } from '@engine/schem.js';
import { BlockGrid } from '@craft/schem/types.js';

/** Initialize upload zone with drag-and-drop and click-to-browse */
export function initUpload(
  zoneEl: HTMLElement,
  fileInput: HTMLInputElement,
  infoEl: HTMLElement,
  onLoaded: (grid: BlockGrid, filename: string) => void,
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
    fileInput.value = ''; // Reset so re-uploading the same file triggers change
  });

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

  async function handleFile(file: File): Promise<void> {
    const uploadText = zoneEl.querySelector('.upload-text') as HTMLElement;
    const uploadSubtext = zoneEl.querySelector('.upload-subtext') as HTMLElement;

    // Validate file extension
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['schem', 'schematic', 'nbt'].includes(ext)) {
      uploadText.textContent = 'Unsupported file type';
      uploadSubtext.textContent = 'Please upload a .schem, .schematic, or .nbt file';
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      uploadText.textContent = 'File too large';
      uploadSubtext.textContent = `Maximum size is ${formatSize(MAX_FILE_SIZE)}, got ${formatSize(file.size)}`;
      return;
    }

    try {
      uploadText.textContent = 'Parsing...';
      uploadSubtext.textContent = file.name;

      const buffer = await file.arrayBuffer();
      const grid = await parseSchemFile(buffer);

      const nonAir = grid.countNonAir();
      const safeName = escapeHtml(file.name);
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

      onLoaded(grid, file.name);
    } catch (err) {
      uploadText.textContent = 'Failed to parse file';
      uploadSubtext.textContent = String(err);
      console.error('Schematic parse error:', err);
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
