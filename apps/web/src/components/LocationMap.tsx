import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

function pinIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function tileLayer(): L.TileLayer {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Interactive map: click or drag to pick a point. Used for choosing a delivery
 * destination (and optionally the origin) when building a route.
 */
export function LocationPicker({
  lat,
  lng,
  onPick,
  height = 260,
}: {
  lat?: number | null;
  lng?: number | null;
  onPick: (lat: number, lng: number) => void;
  height?: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const node = holder.current;
    if (!node || mapRef.current) return;
    const map = L.map(node, { zoomControl: true });
    tileLayer().addTo(map);
    const la = num(lat);
    const ln = num(lng);
    const saved = Number.isFinite(la) && Number.isFinite(ln);
    map.setView(saved ? [la, ln] : [0.35, 32.6], saved ? 15 : 8);
    map.on('click', (event: L.LeafletMouseEvent) => {
      onPickRef.current(Number(event.latlng.lat.toFixed(6)), Number(event.latlng.lng.toFixed(6)));
    });
    mapRef.current = map;
    const fit = window.setTimeout(() => map.invalidateSize(), 50);
    return () => {
      window.clearTimeout(fit);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // The map is created once for this open form; later prop changes move the marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const la = num(lat);
    const ln = num(lng);
    const ok = Number.isFinite(la) && Number.isFinite(ln);
    if (!ok) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      markerRef.current = L.marker([la, ln], { icon: pinIcon('#0f172a'), draggable: true, autoPan: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const p = markerRef.current?.getLatLng();
        if (!p) return;
        onPickRef.current(Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)));
      });
    } else {
      markerRef.current.setLatLng([la, ln]);
    }
  }, [lat, lng]);

  return <div ref={holder} style={{ width: '100%', height, borderRadius: 8 }} />;
}

/**
 * Read-only map showing a route's two endpoints and the line between them.
 * Used on the route detail screen.
 */
export function RouteMap({
  origin,
  destination,
  height = 240,
}: {
  origin?: { lat: number; lng: number; label?: string } | null;
  destination?: { lat: number; lng: number; label?: string } | null;
  height?: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    const node = holder.current;
    if (!node || mapRef.current) return;
    const map = L.map(node, { zoomControl: true, scrollWheelZoom: false });
    tileLayer().addTo(map);
    mapRef.current = map;
    const fit = window.setTimeout(() => map.invalidateSize(), 50);
    return () => {
      window.clearTimeout(fit);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const points: L.LatLngExpression[] = [];
    const o = origin && Number.isFinite(num(origin.lat)) && Number.isFinite(num(origin.lng)) ? origin : null;
    const d = destination && Number.isFinite(num(destination.lat)) && Number.isFinite(num(destination.lng)) ? destination : null;
    if (o) {
      points.push([o.lat, o.lng]);
      L.marker([o.lat, o.lng], { icon: pinIcon('#0f172a') }).addTo(map).bindPopup(o.label ?? 'Origin');
    }
    if (d) {
      points.push([d.lat, d.lng]);
      L.marker([d.lat, d.lng], { icon: pinIcon('#dc2626') }).addTo(map).bindPopup(d.label ?? 'Destination');
    }
    if (o && d) L.polyline([[o.lat, o.lng], [d.lat, d.lng]], { color: '#0f172a', weight: 3, dashArray: '6 6' }).addTo(map);
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [24, 24] });
    else map.setView([0.35, 32.6], 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination]);

  return <div ref={holder} style={{ width: '100%', height, borderRadius: 8 }} />;
}
