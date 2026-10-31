/** Client-side map/geography helpers shared by the logistics map UI. */

/** The factory every route starts from; mirrors services/logistics.ts. */
export const FACTORY_ORIGIN = {
  address: 'Plot 59 Kyambogo Drive, Kyambogo',
  lat: 0.3476,
  lng: 32.6316,
};

export const AVG_SPEED_KMH = 40;

/** Great-circle distance in kilometres (haversine). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  label: string;
}

/**
 * Resolve a typed address to coordinates via the free Nominatim geocoder.
 * Throws when no match is found or the service is unreachable.
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Geocoding service unavailable');
  const body = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const hit = body?.[0];
  if (!hit) throw new Error('No location found for that address');
  return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name };
}
