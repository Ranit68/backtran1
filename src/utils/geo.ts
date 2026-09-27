const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * Great-circle distance in meters between two WGS84 points.
 *
 * Used only when real coordinates exist. The bus and metro source data has no
 * coordinates, so in practice this currently serves nothing -- it is here so
 * that Metro (which does have coordinates) can be plugged in without touching
 * TransferService.
 */
export function haversineDistanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Parses a "latitude, longitude" string, e.g. `"22.471944, 88.398056"`.
 * Returns null rather than a partial value so callers can omit the field
 * instead of storing a wrong coordinate.
 */
export function parseCoordinateString(input: string | null | undefined): Coordinates | null {
  if (!input) return null;
  const parts = input.split(",").map((part) => part.trim());
  if (parts.length !== 2) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!isValidCoordinate(latitude, longitude)) return null;
  return { latitude, longitude };
}
