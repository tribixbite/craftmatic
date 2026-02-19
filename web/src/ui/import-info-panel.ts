/**
 * Info panel rendering — builds the HTML for the generation results panel
 * shown after structure import. Displays address, dimensions, blocks,
 * style, rooms, and all enrichment data rows.
 */

import type { PropertyData } from '@craft/gen/address-pipeline.js';
import type { GenerationOptions } from '@craft/types/index.js';
import { inferDensityFromZip, inferClimateZone } from '@craft/gen/address-pipeline.js';
import type { SeasonalWeather } from '@ui/import-satellite.js';

/** Season display labels */
const SEASON_LABELS: Record<SeasonalWeather, string> = {
  snow: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Autumn',
};

/** Escape HTML to prevent XSS in address display */
export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the inner HTML for the info panel displayed after generation.
 * Takes the generated grid metadata, property data, resolved generation options,
 * and optional OSM footprint dimensions. Returns a string of info-row divs.
 */
export function buildInfoPanelHtml(
  grid: { width: number; height: number; length: number; countNonAir: () => number },
  property: PropertyData,
  options: GenerationOptions,
  osmData?: { widthMeters: number; lengthMeters: number } | null,
): string {
  const nonAir = grid.countNonAir();
  const seasonStr = property.season ? ` | ${SEASON_LABELS[property.season as SeasonalWeather]}` : '';
  const constructionStr = property.newConstruction ? ' (new)' : '';

  // Build optional enrichment rows
  let enrichmentRows = '';
  if (property.lotSize && property.lotSize > 0) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Lot Size</span><span class="info-value">${property.lotSize.toLocaleString()} sqft</span></div>`;
  }
  if (property.exteriorType) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Exterior</span><span class="info-value">${escapeHtml(property.exteriorType)}</span></div>`;
  }
  if (property.detectedColor) {
    const c = property.detectedColor;
    const hex = `rgb(${c.r},${c.g},${c.b})`;
    enrichmentRows += `<div class="info-row"><span class="info-label">Detected Color</span><span class="info-value"><span class="import-color-swatch" style="background:${hex};"></span> ${c.r},${c.g},${c.b}</span></div>`;
  }
  if (property.wallOverride) {
    // Show the mapped wall block name (strip minecraft: prefix)
    const wallName = property.wallOverride.replace('minecraft:', '').replace(/_/g, ' ');
    enrichmentRows += `<div class="info-row"><span class="info-label">Wall Material</span><span class="info-value">${wallName}</span></div>`;
  }
  if (property.roofType) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Roof</span><span class="info-value">${escapeHtml(property.roofType)}</span></div>`;
  }
  if (property.architectureType) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Architecture</span><span class="info-value">${escapeHtml(property.architectureType)}</span></div>`;
  }
  if (property.osmWidth && property.osmLength) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Footprint</span><span class="info-value">${osmData?.widthMeters}m × ${osmData?.lengthMeters}m (OSM)</span></div>`;
  }
  if (property.osmMaterial) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Material</span><span class="info-value">${escapeHtml(property.osmMaterial)} (OSM)</span></div>`;
  }
  if (property.osmRoofShape) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Roof Shape</span><span class="info-value">${escapeHtml(property.osmRoofShape)} (OSM)</span></div>`;
  }

  // Parcl enrichment rows — all 17 fields consumed
  if (property.city) {
    const loc = property.city + (property.stateAbbreviation ? `, ${property.stateAbbreviation}` : '')
      + (property.zipCode ? ` ${property.zipCode}` : '');
    enrichmentRows += `<div class="info-row"><span class="info-label">Location</span><span class="info-value">${escapeHtml(loc)}</span></div>`;
  }
  if (property.county) {
    enrichmentRows += `<div class="info-row"><span class="info-label">County</span><span class="info-value">${escapeHtml(property.county)}</span></div>`;
  }
  if (property.ownerOccupied != null) {
    const occupancy = property.ownerOccupied ? 'Owner-occupied' : 'Rental/Investment';
    const marketStatus = property.onMarket === true ? ' (on market)' : '';
    enrichmentRows += `<div class="info-row"><span class="info-label">Occupancy</span><span class="info-value">${occupancy}${marketStatus}</span></div>`;
  }
  if (property.stateAbbreviation) {
    const climate = inferClimateZone(property.stateAbbreviation);
    const density = inferDensityFromZip(property.zipCode);
    const parts: string[] = [];
    if (climate !== 'temperate') parts.push(`${climate === 'cold' ? 'Cold' : 'Hot'} zone`);
    if (density !== 'suburban') parts.push(density);
    if (parts.length > 0) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Climate/Density</span><span class="info-value">${parts.join(' | ')}</span></div>`;
    }
  }

  // Show inferred generation options
  if (options.roofShape && options.roofShape !== 'gable') {
    enrichmentRows += `<div class="info-row"><span class="info-label">Roof Type</span><span class="info-value">${options.roofShape}</span></div>`;
  }
  if (options.doorOverride) {
    enrichmentRows += `<div class="info-row"><span class="info-label">Door</span><span class="info-value">${options.doorOverride}</span></div>`;
  }
  if (options.features) {
    const feats = Object.entries(options.features)
      .filter(([_, v]) => v === true)
      .map(([k]) => k);
    if (feats.length > 0 && feats.length < 7) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Features</span><span class="info-value">${feats.join(', ')}</span></div>`;
    }
  }

  return `
    <div class="info-row"><span class="info-label">Address</span><span class="info-value" style="font-family:var(--font);font-size:11px;">${escapeHtml(property.address)}</span></div>
    <div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${grid.width} x ${grid.height} x ${grid.length}</span></div>
    <div class="info-row"><span class="info-label">Blocks</span><span class="info-value">${nonAir.toLocaleString()}</span></div>
    <div class="info-row"><span class="info-label">Style</span><span class="info-value">${options.style}${constructionStr}${seasonStr}</span></div>
    <div class="info-row"><span class="info-label">Rooms</span><span class="info-value">${options.rooms?.length ?? 0}</span></div>
    ${enrichmentRows}
  `;
}
