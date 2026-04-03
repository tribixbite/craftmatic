/**
 * Review tab — reusable 3D schematic reviewer with reference image panel.
 * Supports loading multiple .schem/.litematic versions + satellite/street view images.
 * Drag-drop or file picker for both schematics and images.
 */

import { parseSchemFile } from '@engine/schem.js';
import { BlockGrid } from '@craft/schem/types.js';

/** Image extensions we accept as reference images */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'];

/** Schematic extensions we parse */
const SCHEM_EXTENSIONS = ['schem', 'schematic', 'nbt', 'litematic'];

interface VersionEntry {
  grid: BlockGrid;
  filename: string;
}

interface ImageEntry {
  url: string;   // Object URL
  name: string;
}

/** Initialize the Review tab: file loading, version tabs, image panel, lightbox. */
export function initReview(
  root: HTMLElement,
  openViewer: (grid: BlockGrid, label: string) => void,
): void {
  const versions = new Map<string, VersionEntry>();
  const images: ImageEntry[] = [];
  let activeVersion: string | null = null;

  // DOM refs
  const addSchemBtn = root.querySelector('#review-add-schem') as HTMLButtonElement;
  const addImagesBtn = root.querySelector('#review-add-images') as HTMLButtonElement;
  const schemInput = root.querySelector('#review-schem-input') as HTMLInputElement;
  const imageInput = root.querySelector('#review-image-input') as HTMLInputElement;
  const versionsContainer = root.querySelector('#review-versions') as HTMLElement;
  const viewerEl = root.querySelector('#review-viewer') as HTMLElement;
  const imagesEl = root.querySelector('#review-images') as HTMLElement;

  // ─── File picker buttons ───────────────────────────────────────────────────

  addSchemBtn.addEventListener('click', () => schemInput.click());
  addImagesBtn.addEventListener('click', () => imageInput.click());

  schemInput.addEventListener('change', async () => {
    if (!schemInput.files) return;
    for (const file of Array.from(schemInput.files)) {
      await loadSchematic(file);
    }
    schemInput.value = '';
  });

  imageInput.addEventListener('change', () => {
    if (!imageInput.files) return;
    for (const file of Array.from(imageInput.files)) {
      loadImage(file);
    }
    imageInput.value = '';
  });

  // ─── Auto-load from URL params ─────────────────────────────────────────────
  // ?load=review/flatiron-v307.schem,review/seattle-library-v307.schem,...
  const loadParam = new URLSearchParams(window.location.search).get('load');
  if (loadParam) {
    const urls = loadParam.split(',').map(u => u.trim()).filter(Boolean);
    for (const url of urls) {
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.arrayBuffer(); })
        .then(async buf => {
          const name = url.split('/').pop() ?? url;
          const file = new File([buf], name);
          await loadSchematic(file);
        })
        .catch(err => console.error(`[review] Failed to fetch ${url}:`, err));
    }
  }

  // ─── Drag-drop on entire review tab ────────────────────────────────────────

  root.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    root.classList.add('review-dragover');
  });

  root.addEventListener('dragleave', (e) => {
    // Only remove class when leaving the root element itself
    if (e.target === root || !root.contains(e.relatedTarget as Node)) {
      root.classList.remove('review-dragover');
    }
  });

  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    root.classList.remove('review-dragover');

    const files = e.dataTransfer?.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (SCHEM_EXTENSIONS.includes(ext)) {
        await loadSchematic(file);
      } else if (IMAGE_EXTENSIONS.includes(ext)) {
        loadImage(file);
      }
    }
  });

  // ─── Schematic loading ─────────────────────────────────────────────────────

  async function loadSchematic(file: File): Promise<void> {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const stem = file.name.replace(/\.[^.]+$/, '');

    try {
      const buffer = await file.arrayBuffer();
      let grid: BlockGrid;

      if (ext === 'litematic') {
        const { parseLitematicFile } = await import('@engine/litematic.js');
        grid = await parseLitematicFile(buffer);
      } else {
        grid = await parseSchemFile(buffer);
      }

      versions.set(stem, { grid, filename: file.name });
      renderVersionTabs();

      // Auto-activate first loaded version, or newly loaded version
      activateVersion(stem);
    } catch (err) {
      console.error(`[review] Failed to parse ${file.name}:`, err);
    }
  }

  // ─── Image loading ─────────────────────────────────────────────────────────

  function loadImage(file: File): void {
    const url = URL.createObjectURL(file);
    images.push({ url, name: file.name });
    renderImagePanel();
  }

  // ─── Version tabs ──────────────────────────────────────────────────────────

  function renderVersionTabs(): void {
    versionsContainer.innerHTML = '';
    // Sort by name for consistent ordering
    const sorted = [...versions.keys()].sort();
    for (const key of sorted) {
      const btn = document.createElement('button');
      btn.className = 'review-version-tab';
      if (key === activeVersion) btn.classList.add('active');
      btn.textContent = key;
      btn.title = versions.get(key)!.filename;
      btn.addEventListener('click', () => activateVersion(key));
      versionsContainer.appendChild(btn);
    }
  }

  function activateVersion(key: string): void {
    const entry = versions.get(key);
    if (!entry) return;

    activeVersion = key;

    // Update tab button highlights
    versionsContainer.querySelectorAll('.review-version-tab').forEach(btn => {
      btn.classList.toggle('active', btn.textContent === key);
    });

    // Clear placeholder if present
    const placeholder = viewerEl.querySelector('.viewer-placeholder');
    if (placeholder) placeholder.remove();

    // Call the openViewer callback (main.ts will call showInlineViewer)
    openViewer(entry.grid, key);
  }

  // ─── Image panel ───────────────────────────────────────────────────────────

  function renderImagePanel(): void {
    imagesEl.innerHTML = '';

    if (images.length === 0) {
      imagesEl.innerHTML = '<div class="review-images-placeholder"><p>Drop reference images (satellite, street view, renders)</p></div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'review-thumb-grid';

    for (const img of images) {
      const thumb = document.createElement('div');
      thumb.className = 'review-thumb';

      const imgEl = document.createElement('img');
      imgEl.src = img.url;
      imgEl.alt = img.name;
      imgEl.loading = 'lazy';

      const label = document.createElement('div');
      label.className = 'review-thumb-label';
      label.textContent = img.name;
      label.title = img.name;

      thumb.appendChild(imgEl);
      thumb.appendChild(label);

      // Click → lightbox
      thumb.addEventListener('click', () => showLightbox(img.url, img.name));

      grid.appendChild(thumb);
    }

    imagesEl.appendChild(grid);
  }

  // ─── Lightbox ──────────────────────────────────────────────────────────────

  function showLightbox(url: string, name: string): void {
    const overlay = document.createElement('div');
    overlay.className = 'review-lightbox';

    const img = document.createElement('img');
    img.src = url;
    img.alt = name;

    overlay.appendChild(img);

    const close = () => overlay.remove();
    overlay.addEventListener('click', close);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
  }
}
