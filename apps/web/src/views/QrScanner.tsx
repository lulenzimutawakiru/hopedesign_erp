import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';

export interface QrScanResult {
  code: string;
  status: string;
  result?: string;
  entityType?: string | null;
  entityId?: number | null;
  productCode?: string | null;
  productName?: string | null;
  batchNo?: string | null;
  message?: string;
  [key: string]: unknown;
}

export default function QrScanner({ onClose, sheet }: { onClose: () => void; sheet?: boolean }) {
  const { user } = useAuth();
  const [code, setCode] = useState('');
  const [action, setAction] = useState('VERIFY');
  const [location, setLocation] = useState('');
  const [result, setResult] = useState<QrScanResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [camHint, setCamHint] = useState('Align the mark inside the frame');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const lockedRef = useRef(false);
  const actionRef = useRef(action);
  const locationRef = useRef(location);
  const postRef = useRef<(raw: string) => Promise<void>>(async () => undefined);
  actionRef.current = action;
  locationRef.current = location;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const postCode = async (raw: string) => {
    const c = raw.trim();
    if (!c || lockedRef.current) return;
    lockedRef.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ data: QrScanResult }>('/api/qr/scan', {
        method: 'POST',
        body: JSON.stringify({
          code: c,
          action: actionRef.current || undefined,
          location: locationRef.current || undefined,
          device: cameraOn ? 'camera' : 'manual',
        }),
      });
      setResult(r.data);
      setCode('');
      stopCamera();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
      lockedRef.current = false;
    } finally {
      setBusy(false);
    }
  };
  postRef.current = postCode;

  const tick = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    const decoded = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
    if (decoded?.data) {
      setCamHint('Code locked');
      void postRef.current(decoded.data);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const startCamera = async () => {
    setError('');
    lockedRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      setCamHint('Align the mark inside the frame');
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
          rafRef.current = requestAnimationFrame(tick);
        }
      });
    } catch {
      setError('Camera blocked or unavailable. Type the code or use a handheld scanner.');
    }
  };

  const scan = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    lockedRef.current = false;
    await postCode(code);
  };

  return (
    <div className={`modal-backdrop ${sheet ? 'sheet-backdrop' : ''}`} onClick={onClose}>
      <div className={`modal qr-modal ${sheet ? 'sheet-modal' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Scan QR">
        <div className="modal-head">
          <h3>Scan QR</h3>
          <button className="btn btn-ghost" onClick={() => { stopCamera(); onClose(); }}>✕</button>
        </div>
        {cameraOn ? (
          <div className="cam-stage">
            <video ref={videoRef} playsInline muted autoPlay className="cam-video" />
            <div className="cam-frame" aria-hidden="true" />
            <p className="cam-hint">{camHint}</p>
            <button type="button" className="btn btn-sm" onClick={stopCamera}>Stop camera</button>
          </div>
        ) : (
          <div className="quick-actions">
            <button type="button" className="btn btn-primary" onClick={() => void startCamera()}>Open camera</button>
          </div>
        )}
        <canvas ref={canvasRef} hidden />
        <form onSubmit={scan}>
          <label className="field">
            <span>QR code / payload</span>
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="HDG-FG-2026-00000001 or scan with USB/handheld"
            />
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Action</span>
              <select value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="VERIFY">Verify</option>
                <option value="RECEIVE">Receive</option>
                <option value="PUT_AWAY">Put away</option>
                <option value="MOVE">Move</option>
                <option value="TRANSFER">Transfer</option>
                <option value="PICK">Pick</option>
                <option value="ISSUE">Issue</option>
                <option value="COUNT">Count</option>
                <option value="ADJUST">Adjust</option>
                <option value="INSPECT">Inspect</option>
                <option value="DISPATCH">Dispatch</option>
                <option value="DELIVER">Deliver</option>
                <option value="TRACK">Track</option>
              </select>
            </label>
            <label className="field">
              <span>Location (optional)</span>
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="WH-01 / A-01" />
            </label>
          </div>
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy || !code.trim()}>
            {busy ? 'Scanning…' : 'Scan'}
          </button>
        </form>
        {result && (
          <div className={`scan-result ${['AUTHENTIC', 'VERIFIED'].includes(String(result.result ?? result.status ?? '').toUpperCase()) ? 'scan-verified' : ''}`}>
            {['AUTHENTIC', 'VERIFIED'].includes(String(result.result ?? result.status ?? '').toUpperCase()) && (
              <>
                <div className="verify-mark">✓ QR VERIFIED</div>
                <div className="verify-code">{result.code}</div>
              </>
            )}
            <div className="result-row">
              <span>Code</span><strong>{result.code}</strong>
            </div>
            <div className="result-row">
              <span>Result</span>
              <span className={`badge ${result.result === 'AUTHENTIC' || result.result === 'VERIFIED' ? 'badge-teal' : result.result === 'ALREADY_VERIFIED' ? 'badge-warn' : result.result === 'UNKNOWN' || result.result === 'COMPROMISED' ? 'badge-danger' : result.result === 'SUSPICIOUS' ? 'badge-warn' : 'badge-info'}`}>
                <span className="badge-icon" aria-hidden>{result.result === 'AUTHENTIC' || result.result === 'VERIFIED' ? '✓' : result.result === 'UNKNOWN' || result.result === 'COMPROMISED' ? '✕' : result.result === 'SUSPICIOUS' || result.result === 'ALREADY_VERIFIED' ? '⚠' : '●'}</span>
                {result.result ?? result.status ?? 'OK'}
              </span>
            </div>
            {result.productCode && (
              <div className="result-row"><span>Product</span><strong>{result.productName ?? result.productCode}</strong></div>
            )}
            {result.batchNo && (
              <div className="result-row"><span>Batch</span><strong>{result.batchNo}</strong></div>
            )}
            {result.message && (
              <div className="result-row"><span>Detail</span><strong>{result.message}</strong></div>
            )}
            <div className="quick-actions scan-actions">
              {result.entityId && <button className="btn" onClick={() => { onClose(); navigate(`/inventory/items/${result.entityId}`); }}>View</button>}
              <button className="btn btn-primary" onClick={() => { onClose(); navigate(`/qr/${result.code}`); }}>Trace</button>
              {can(user, 'inventory.transfers.create') && <button className="btn" onClick={() => { onClose(); navigate('/inventory/transfers/new'); }}>Move</button>}
              {can(user, 'inventory.adjustments.create') && <button className="btn" onClick={() => { onClose(); navigate('/inventory/adjustments/new'); }}>Count</button>}
            </div>
          </div>
        )}
        <p className="hint">
          Signed in as {user?.username ?? user?.email}. Every scan is authenticated, authorized, and written to the audit log.
        </p>
      </div>
    </div>
  );
}
