/** Great-circle distance between two points in statute miles (haversine, mean Earth radius). */
export function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const EARTH_RADIUS_MILES = 3958.7613;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}
