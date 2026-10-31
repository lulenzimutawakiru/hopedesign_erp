import { useMemo, useState } from 'react';
import { LocationPicker } from '../components/LocationMap';
import { AVG_SPEED_KMH, FACTORY_ORIGIN, geocodeAddress, haversineKm } from '../geo';

type Rec = Record<string, unknown>;

/** "Kyambogo" from "Plot 59 Kyambogo Drive, Kyambogo". */
function originName(origin: string): string {
  const parts = origin.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || 'Factory';
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v: number | null): string {
  return v == null ? '' : String(v);
}

export interface RouteFormProps {
  initial?: Record<string, unknown> | null;
  onSubmit: (values: Rec) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export function RouteForm({ initial, onSubmit, onCancel, submitLabel = 'Save' }: RouteFormProps) {
  const [origin, setOrigin] = useState<string>(String(initial?.origin ?? FACTORY_ORIGIN.address));
  const [originLat, setOriginLat] = useState<number | null>(num(initial?.originLat) ?? FACTORY_ORIGIN.lat);
  const [originLng, setOriginLng] = useState<number | null>(num(initial?.originLng) ?? FACTORY_ORIGIN.lng);
  const [destination, setDestination] = useState<string>(String(initial?.destination ?? ''));
  const [destinationLat, setDestinationLat] = useState<number | null>(num(initial?.destinationLat));
  const [destinationLng, setDestinationLng] = useState<number | null>(num(initial?.destinationLng));
  const [showOriginMap, setShowOriginMap] = useState(false);
  const [error, setError] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [busy, setBusy] = useState(false);

  // Distance and ETA derive from the two endpoints; they stay editable so a
  // dispatcher can override the straight-line estimate with a real figure.
  const derived = useMemo(() => {
    if (originLat == null || originLng == null || destinationLat == null || destinationLng == null) {
      return { km: num(initial?.distanceKm), hours: num(initial?.estimatedHours) };
    }
    const km = haversineKm(originLat, originLng, destinationLat, destinationLng);
    return { km, hours: Math.round((km / AVG_SPEED_KMH) * 10) / 10 };
  }, [originLat, originLng, destinationLat, destinationLng, initial]);

  const [distanceKm, setDistanceKm] = useState<string>(fmt(derived.km));
  const [estimatedHours, setEstimatedHours] = useState<string>(fmt(derived.hours));

  const applyDerived = (km: number | null, hours: number | null) => {
    setDistanceKm(fmt(km));
    setEstimatedHours(fmt(hours));
  };

  const pickDestination = (lat: number, lng: number) => {
    setDestinationLat(lat);
    setDestinationLng(lng);
    if (originLat != null && originLng != null) {
      const km = haversineKm(originLat, originLng, lat, lng);
      applyDerived(km, Math.round((km / AVG_SPEED_KMH) * 10) / 10);
    }
  };

  const pickOrigin = (lat: number, lng: number) => {
    setOriginLat(lat);
    setOriginLng(lng);
    if (destinationLat != null && destinationLng != null) {
      const km = haversineKm(lat, lng, destinationLat, destinationLng);
      applyDerived(km, Math.round((km / AVG_SPEED_KMH) * 10) / 10);
    }
  };

  const locate = async () => {
    const q = destination.trim();
    if (!q) { setError('Type a destination address first.'); return; }
    setGeocoding(true);
    setError('');
    try {
      const hit = await geocodeAddress(q);
      setDestinationLat(hit.lat);
      setDestinationLng(hit.lng);
      pickDestination(hit.lat, hit.lng);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not find that location.');
    } finally {
      setGeocoding(false);
    }
  };

  const submit = async () => {
    setError('');
    if (!destination.trim()) { setError('Destination is required.'); return; }
    setBusy(true);
    try {
      const values: Rec = {
        name: `${originName(origin)} → ${destination.trim()}`,
        origin: origin.trim() || FACTORY_ORIGIN.address,
        destination: destination.trim(),
        originLat, originLng,
        destinationLat, destinationLng,
        distanceKm: distanceKm === '' ? null : Number(distanceKm),
        estimatedHours: estimatedHours === '' ? null : Number(estimatedHours),
      };
      await onSubmit(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="form-sec">Route</div>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="rf-origin">Origin (factory)</label>
          <input id="rf-origin" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder={FACTORY_ORIGIN.address} />
          <span className="field-hint">Where the truck leaves from. Defaults to the factory.</span>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="rf-dest">Destination</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="rf-dest" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Customer address, town or landmark" style={{ flex: 1 }} />
            <button className="btn" type="button" onClick={locate} disabled={geocoding}>{geocoding ? 'Locating…' : 'Find on map'}</button>
          </div>
          <span className="field-hint">Type an address and press “Find on map”, or click the map below.</span>
        </div>
      </div>

      <div className="form-sec">Map</div>
      <div className="field" style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 13 }}>Destination — click the map or drag the marker to set the delivery point.</span>
      </div>
      <LocationPicker lat={destinationLat} lng={destinationLng} onPick={pickDestination} height={280} />

      <button className="btn btn-sm" type="button" style={{ marginTop: 8 }} onClick={() => setShowOriginMap((v) => !v)}>
        {showOriginMap ? 'Hide origin map' : 'Set origin on map'}
      </button>
      {showOriginMap && <div style={{ marginTop: 8 }}><LocationPicker lat={originLat} lng={originLng} onPick={pickOrigin} height={220} /></div>}

      <div className="form-sec">Distance &amp; time</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="rf-km">Distance (km)</label>
          <input id="rf-km" type="number" inputMode="decimal" min={0} value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} />
          <span className="field-hint">Filled from the map; override for a real road distance.</span>
        </div>
        <div className="field">
          <label htmlFor="rf-hrs">Estimated time (hours)</label>
          <input id="rf-hrs" type="number" inputMode="decimal" min={0} value={estimatedHours} onChange={(e) => setEstimatedHours(e.target.value)} />
          <span className="field-hint">At ~{AVG_SPEED_KMH} km/h. Adjust for traffic.</span>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </div>
  );
}
