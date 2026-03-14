/**
 * Coordinate projection between WGS84 lat/lng and BlockGrid XZ coordinates.
 *
 * Uses equirectangular approximation (accurate within 1m for radii < 500m).
 * Supports a calibration offset from alignOSMToFootprint to correct
 * photogrammetry geocoding drift.
 *
 * The projection maps geographic east (+lng) to grid +X and geographic
 * north (+lat) to grid -Z, matching Minecraft's coordinate convention
 * where +X = east and +Z = south.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** Degrees-to-radians conversion factor */
const DEG2RAD = Math.PI / 180;

/** Meters per degree of latitude (constant at all latitudes) */
const METERS_PER_DEG_LAT = 111320;

// ─── Projection Class ───────────────────────────────────────────────────────

/**
 * Bi-directional projection between WGS84 lat/lng and BlockGrid XZ coordinates.
 *
 * Grid origin is the geographic center of the capture area. The optional
 * calibration offset (from `alignOSMToFootprint` in mesh-filter.ts) corrects
 * for photogrammetry geocoding drift — typically 1-20 blocks for Google 3D Tiles.
 *
 * @example
 * ```ts
 * const proj = new GeoProjection(37.7749, -122.4194, 1, 64, 64);
 * const { x, z } = proj.toGridXZ(37.7751, -122.4190);
 * const { lat, lng } = proj.toLatLng(x, z);
 * ```
 */
export class GeoProjection {
  /** Cosine of center latitude — scales longitude distances */
  private readonly cosLat: number;
  /** Meters per degree of latitude (constant ≈ 111,320 m) */
  private readonly metersPerDegLat: number;
  /** Meters per degree of longitude at center latitude */
  private readonly metersPerDegLng: number;

  /**
   * @param centerLat   Center latitude in decimal degrees (WGS84)
   * @param centerLng   Center longitude in decimal degrees (WGS84)
   * @param resolution  Blocks per meter (1 = 1:1 Minecraft scale, 2 = half-meter blocks)
   * @param gridCenterX Grid X coordinate corresponding to the geographic center
   * @param gridCenterZ Grid Z coordinate corresponding to the geographic center
   * @param calibrationDx Calibration offset in grid X units from alignOSMToFootprint
   * @param calibrationDz Calibration offset in grid Z units from alignOSMToFootprint
   */
  constructor(
    private readonly centerLat: number,
    private readonly centerLng: number,
    private readonly resolution: number,
    private readonly gridCenterX: number,
    private readonly gridCenterZ: number,
    private readonly calibrationDx = 0,
    private readonly calibrationDz = 0,
  ) {
    this.cosLat = Math.cos(centerLat * DEG2RAD);
    this.metersPerDegLat = METERS_PER_DEG_LAT;
    this.metersPerDegLng = METERS_PER_DEG_LAT * this.cosLat;
  }

  /**
   * Project a WGS84 lat/lng coordinate to grid XZ, applying calibration offset.
   *
   * Mapping: geographic east (+lng) → grid +X, geographic north (+lat) → grid -Z.
   * This matches Minecraft's convention where +X = east and +Z = south.
   *
   * @param lat Latitude in decimal degrees
   * @param lng Longitude in decimal degrees
   * @returns Grid coordinates { x, z } rounded to nearest integer
   */
  toGridXZ(lat: number, lng: number): { x: number; z: number } {
    const dLat = lat - this.centerLat;
    const dLng = lng - this.centerLng;
    const metersN = dLat * this.metersPerDegLat;
    const metersE = dLng * this.metersPerDegLng;
    // +X = east, +Z = south (north is -Z)
    return {
      x: Math.round(this.gridCenterX + metersE * this.resolution + this.calibrationDx),
      z: Math.round(this.gridCenterZ - metersN * this.resolution + this.calibrationDz),
    };
  }

  /**
   * Project grid XZ coordinates back to WGS84 lat/lng, reversing calibration offset.
   *
   * @param x Grid X coordinate
   * @param z Grid Z coordinate
   * @returns Geographic coordinates { lat, lng } in decimal degrees
   */
  toLatLng(x: number, z: number): { lat: number; lng: number } {
    const dx = (x - this.gridCenterX - this.calibrationDx) / this.resolution;
    const dz = (z - this.gridCenterZ - this.calibrationDz) / this.resolution;
    return {
      lat: this.centerLat - dz / this.metersPerDegLat,
      lng: this.centerLng + dx / this.metersPerDegLng,
    };
  }

  /**
   * Check if grid coordinates are within a grid of given dimensions.
   * Grid is assumed to span [0, width) in X and [0, length) in Z.
   *
   * @param x Grid X coordinate
   * @param z Grid Z coordinate
   * @param width Grid width (X axis extent)
   * @param length Grid length (Z axis extent)
   * @returns True if (x, z) is within bounds
   */
  isInBounds(x: number, z: number, width: number, length: number): boolean {
    return x >= 0 && x < width && z >= 0 && z < length;
  }

  /** Get the resolution in blocks per meter */
  getResolution(): number {
    return this.resolution;
  }

  /** Get the geographic center as { lat, lng } */
  getCenter(): { lat: number; lng: number } {
    return { lat: this.centerLat, lng: this.centerLng };
  }

  /** Get the grid center as { x, z } */
  getGridCenter(): { x: number; z: number } {
    return { x: this.gridCenterX, z: this.gridCenterZ };
  }

  /** Get the calibration offset as { dx, dz } */
  getCalibration(): { dx: number; dz: number } {
    return { dx: this.calibrationDx, dz: this.calibrationDz };
  }
}
