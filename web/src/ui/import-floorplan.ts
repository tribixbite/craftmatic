/**
 * Floor plan analysis — lightweight canvas-based room detection.
 * No external dependencies (no OpenCV, no WASM).
 *
 * Algorithm:
 * 1. Draw image at reduced resolution (max 400px)
 * 2. Grayscale conversion → Otsu thresholding → binary (walls=dark, rooms=light)
 * 3. Iterative BFS flood fill on light regions
 * 4. Filter by area (2%-80% of image area)
 * 5. Return bounding boxes sorted by area descending
 */

export interface DetectedRoom {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

export interface FloorPlanAnalysis {
  rooms: DetectedRoom[];
  aspectRatio: number;
  imageWidth: number;
  imageHeight: number;
}

/** Max dimension for analysis (keeps processing fast) */
const MAX_DIM = 400;

/** Min/max room area as fraction of total image area */
const MIN_ROOM_FRAC = 0.02;
const MAX_ROOM_FRAC = 0.80;

/**
 * Analyze a floor plan image to detect room regions.
 * Returns bounding boxes for detected rooms and the overall aspect ratio.
 */
export function analyzeFloorPlan(image: HTMLImageElement): FloorPlanAnalysis {
  // Scale image to fit within MAX_DIM while preserving aspect ratio
  const scale = Math.min(1, MAX_DIM / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.round(image.naturalWidth * scale);
  const h = Math.round(image.naturalHeight * scale);

  // Draw to offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h);
  const pixels = imageData.data;

  // Convert to grayscale array
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    // ITU-R BT.601 luma
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  // Otsu's threshold
  const threshold = otsuThreshold(gray);

  // Binary image: true = light (room), false = dark (wall)
  const binary = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    binary[i] = gray[i] > threshold ? 1 : 0;
  }

  // BFS flood fill to find connected light regions
  const visited = new Uint8Array(w * h);
  const rooms: DetectedRoom[] = [];
  const totalArea = w * h;
  const minArea = Math.floor(totalArea * MIN_ROOM_FRAC);
  const maxArea = Math.floor(totalArea * MAX_ROOM_FRAC);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx] || !binary[idx]) continue;

      // BFS flood fill from this pixel
      const region = bfsFloodFill(binary, visited, w, h, x, y);
      if (region.area >= minArea && region.area <= maxArea) {
        // Scale bounding box back to original image coordinates
        rooms.push({
          x: Math.round(region.minX / scale),
          y: Math.round(region.minY / scale),
          width: Math.round((region.maxX - region.minX + 1) / scale),
          height: Math.round((region.maxY - region.minY + 1) / scale),
          area: Math.round(region.area / (scale * scale)),
        });
      }
    }
  }

  // Sort by area descending
  rooms.sort((a, b) => b.area - a.area);

  return {
    rooms,
    aspectRatio: image.naturalWidth / image.naturalHeight,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
  };
}

/** Otsu's method for automatic threshold selection */
function otsuThreshold(gray: Uint8Array): number {
  // Build histogram
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) {
    hist[gray[i]]++;
  }

  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let sumBg = 0;
  let wBg = 0;
  let maxVariance = 0;
  let bestThreshold = 0;

  for (let t = 0; t < 256; t++) {
    wBg += hist[t];
    if (wBg === 0) continue;

    const wFg = total - wBg;
    if (wFg === 0) break;

    sumBg += t * hist[t];
    const meanBg = sumBg / wBg;
    const meanFg = (sumAll - sumBg) / wFg;
    const diff = meanBg - meanFg;
    const variance = wBg * wFg * diff * diff;

    if (variance > maxVariance) {
      maxVariance = variance;
      bestThreshold = t;
    }
  }

  return bestThreshold;
}

/** BFS flood fill — returns bounding box and area of connected region */
function bfsFloodFill(
  binary: Uint8Array,
  visited: Uint8Array,
  w: number,
  h: number,
  startX: number,
  startY: number,
): { minX: number; minY: number; maxX: number; maxY: number; area: number } {
  let minX = startX, maxX = startX, minY = startY, maxY = startY;
  let area = 0;

  // Use typed array as queue for performance (pre-allocate reasonable size)
  const queue: number[] = [];
  const startIdx = startY * w + startX;
  visited[startIdx] = 1;
  queue.push(startIdx);

  while (queue.length > 0) {
    const idx = queue.shift()!;
    const px = idx % w;
    const py = (idx - px) / w;
    area++;

    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;

    // 4-connected neighbors
    const neighbors = [
      py > 0 ? idx - w : -1,       // up
      py < h - 1 ? idx + w : -1,   // down
      px > 0 ? idx - 1 : -1,       // left
      px < w - 1 ? idx + 1 : -1,   // right
    ];

    for (const nIdx of neighbors) {
      if (nIdx >= 0 && !visited[nIdx] && binary[nIdx]) {
        visited[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  return { minX, minY, maxX, maxY, area };
}
