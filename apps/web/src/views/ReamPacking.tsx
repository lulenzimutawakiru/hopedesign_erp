import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, PageLoader } from '../components/ui';
import { pick } from '../helpers';

interface ProductRow {
  id: number;
  code?: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

interface BatchRow {
  id: number;
  batchNo?: string;
  batch_no?: string;
  lotNo?: string;
  quantity?: number;
  status?: string;
  [key: string]: unknown;
}

interface ReamGeneratedRow {
  id: number;
  reamNo?: string;
  qrId?: number;
  code?: string;
  secret?: string;
  payload?: string;
  [key: string]: unknown;
}

interface CartonResult {
  cartonId?: number;
  cartonNo?: string;
  qrId?: number;
  code?: string;
  secret?: string;
  payload?: string;
  reams?: { reamId: number; reamNo: string; qrId: number; code: string }[];
  [key: string]: unknown;
}

interface PackingSummary {
  productId: number;
  batchId: number | null;
  plannedQty?: number;
  generatedQty?: number;
  remainingToGenerate?: number;
  onHand?: number;
  looseReams?: number;
  packedReams?: number;
  cartonsSealed?: number;
  statusCounts?: Record<string, number>;
  [key: string]: unknown;
}

interface BatchCapacityRow {
  batchId: number;
  batchNo: string;
  plannedQty?: number;
  generatedQty?: number;
  remainingToGenerate?: number;
  capacityReached?: boolean;
  [key: string]: unknown;
}

interface SpooledLabel {
  id: number;
  labelNo: string;
  code: string;
  imageDataUrl?: string;
  [key: string]: unknown;
}

interface SpoolResult {
  jobNo: string;
  jobId: number;
  labels: SpooledLabel[];
}

interface LabelTemplateRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  mmWidth?: number | null;
  mmHeight?: number | null;
  printerModel?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  [key: string]: unknown;
}

const REAMS_PER_CARTON = 5;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => Number(v ?? 0);

const copyText = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

type LabelKind = 'REAM' | 'CARTON';

interface NiimbotModelDef {
  key: string;
  label: string;
  id: number;
  dpi: number;
  task: 'v4' | 'b1';
  density: number;
  label_type: number;
  speed: number;
  name_prefixes: string[];
}

/** Subset of the niimbot-web-bluetooth registry.json, keyed by printer model id. */
const NIIMBOT_MODELS: Record<number, NiimbotModelDef> = {
  4097: { key: 'b1pro', label: 'Niimbot B1 Pro', id: 4097, dpi: 300, task: 'v4', density: 3, label_type: 1, speed: 1, name_prefixes: ['B1'] },
  6912: { key: 'b2pro', label: 'Niimbot B2 Pro', id: 6912, dpi: 300, task: 'v4', density: 3, label_type: 1, speed: 1, name_prefixes: ['B2'] },
  4096: { key: 'b1', label: 'Niimbot B1', id: 4096, dpi: 203, task: 'b1', density: 3, label_type: 1, speed: 1, name_prefixes: ['B1'] },
  4098: { key: 'b1se', label: 'Niimbot B1 SE', id: 4098, dpi: 203, task: 'b1', density: 3, label_type: 1, speed: 1, name_prefixes: ['B1'] },
  528: { key: 'd11h', label: 'Niimbot D11_H', id: 528, dpi: 300, task: 'v4', density: 3, label_type: 1, speed: 1, name_prefixes: ['D11'] },
  4608: { key: 'm2h', label: 'Niimbot M2-H', id: 4608, dpi: 300, task: 'b1', density: 3, label_type: 1, speed: 1, name_prefixes: ['M2'] },
  2304: { key: 'd110', label: 'Niimbot D110', id: 2304, dpi: 203, task: 'b1', density: 3, label_type: 1, speed: 1, name_prefixes: ['D110'] },
  3586: { key: 'n1', label: 'Niimbot N1', id: 3586, dpi: 203, task: 'b1', density: 3, label_type: 1, speed: 1, name_prefixes: ['N1'] },
};

const LABEL_DIMS: Record<LabelKind, { key: string; label: string; mmW: number; mmH: number }> = {
  REAM: { key: 'REAM40x25', label: 'Ream label 40x25mm', mmW: 40, mmH: 25 },
  CARTON: { key: 'CARTON60x40', label: 'Carton label 60x40mm', mmW: 60, mmH: 40 },
};

const mmToPx = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

export default function ReamPacking() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [productId, setProductId] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Production batches - the batch number is printed on every ream/carton label
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [batchId, setBatchId] = useState<number>(0);
  const [batchError, setBatchError] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMsg, setBatchMsg] = useState('');

  // Create a new ream product
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [newProduct, setNewProduct] = useState({ name: '', gsm: '', sheetsPerReam: '', widthMm: '' });
  const [productBusy, setProductBusy] = useState(false);
  const [productError, setProductError] = useState('');
  const [productMsg, setProductMsg] = useState('');

  // Create a new production batch
  const [showNewBatch, setShowNewBatch] = useState(false);
  const [newBatch, setNewBatch] = useState({ quantity: '', lotNo: '', expiryDate: '', notes: '' });

  // Generate reams
  const [count, setCount] = useState(5);
  const [generated, setGenerated] = useState<ReamGeneratedRow[]>([]);
  const [genError, setGenError] = useState('');
  const [genWarn, setGenWarn] = useState('');
  const [genBusy, setGenBusy] = useState(false);

  // Ream label printing
  const [spool, setSpool] = useState<SpoolResult | null>(null);
  const [spoolError, setSpoolError] = useState('');
  const [spoolBusy, setSpoolBusy] = useState(false);

  // Label varieties (selectable physical sizes for ream/carton labels)
  const [templates, setTemplates] = useState<LabelTemplateRow[]>([]);
  const [reamTemplateId, setReamTemplateId] = useState(0);
  const [cartonTemplateId, setCartonTemplateId] = useState(0);
  const [spoolTemplateId, setSpoolTemplateId] = useState(0);
  const [templatesError, setTemplatesError] = useState('');

  // Bluetooth printing (Niimbot via Web Bluetooth)
  const [spoolKind, setSpoolKind] = useState<LabelKind>('REAM');
  const [btBusy, setBtBusy] = useState(false);
  const [btStatus, setBtStatus] = useState('');
  const [btError, setBtError] = useState('');

  // USB printing (Niimbot via Web Serial)
  const [usbBusy, setUsbBusy] = useState(false);
  const [usbStatus, setUsbStatus] = useState('');
  const [usbError, setUsbError] = useState('');
  const [usbPaired, setUsbPaired] = useState(0);
  const [usbDebug, setUsbDebug] = useState(false);

  // Printer discovery over Bluetooth and USB (native device choosers)
  const [discoverStatus, setDiscoverStatus] = useState('');
  const [discoverError, setDiscoverError] = useState('');
  const [discovered, setDiscovered] = useState<{ transport: string; name: string; detail?: string } | null>(null);

  // Packing line
  const [scanned, setScanned] = useState<{ code: string; reamNo: string; status: string }[]>([]);
  const [scanInput, setScanInput] = useState('');
  const [scanError, setScanError] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [carton, setCarton] = useState<CartonResult | null>(null);
  const [sealBusy, setSealBusy] = useState(false);
  const [sealError, setSealError] = useState('');

  // Live stock & flow for the selected product/batch
  const [summary, setSummary] = useState<PackingSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Per-batch planned-vs-generated capacity for the batch selector
  const [capacity, setCapacity] = useState<Record<number, BatchCapacityRow> | null>(null);
  const capacityReqRef = useRef(0);

  // Success toast + carton scroll target
  const [flashMsg, setFlashMsg] = useState('');
  const flashMsgTimer = useRef<number | null>(null);
  const cartonRef = useRef<HTMLDivElement>(null);

  // Scanner refocus + transient feedback
  const scanRef = useRef<HTMLInputElement>(null);
  const [scanFlash, setScanFlash] = useState('');
  const flashTimer = useRef<number | null>(null);

  const showFlash = (msg: string) => {
    setFlashMsg(msg);
    if (flashMsgTimer.current) window.clearTimeout(flashMsgTimer.current);
    flashMsgTimer.current = window.setTimeout(() => setFlashMsg(''), 4000);
  };

  useEffect(() => {
    api<{ data: ProductRow[] }>('/api/inventory/items?pageSize=100')
      .then((r) => {
        const reams = (r.data ?? []).filter((p) => str(p.type) === 'REAM');
        setProducts(reams);
        if (reams.length > 0) setProductId(num(reams[0].id));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load ream products'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api<{ data: LabelTemplateRow[] }>('/api/qr/labels/templates?activeOnly=true')
      .then((r) => {
        const rows = r.data ?? [];
        setTemplates(rows);
        const reamDefault = rows.find((t) => t.kind === 'REAM' && t.isDefault);
        const cartonDefault = rows.find((t) => t.kind === 'CARTON' && t.isDefault);
        setReamTemplateId(num(reamDefault?.id ?? rows.find((t) => t.kind === 'REAM')?.id));
        setCartonTemplateId(num(cartonDefault?.id ?? rows.find((t) => t.kind === 'CARTON')?.id));
      })
      .catch((e) => setTemplatesError(e instanceof Error ? e.message : 'Failed to load label varieties'));
  }, []);

  const loadBatches = useCallback(async (pid: number) => {
    if (!pid) {
      setBatches([]);
      setBatchId(0);
      return;
    }
    setBatches([]);
    setBatchId(0);
    setBatchError('');
    try {
      const r = await api<{ data: BatchRow[] }>(
        `/api/inventory/batches?productId=${pid}&status=ACTIVE&pageSize=100`
      );
      const rows = r.data ?? [];
      setBatches(rows);
      const first = rows[0];
      setBatchId(first ? num(first.id) : 0);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Failed to load production batches');
    }
  }, []);

  useEffect(() => {
    if (productId) void loadBatches(productId);
  }, [productId, loadBatches]);

  const loadSummary = useCallback(async (pid: number, bid: number) => {
    if (!pid || !bid) {
      setSummary(null);
      return;
    }
    setSummaryLoading(true);
    try {
      const r = await api<{ data: PackingSummary }>(
        `/api/qr/packing/summary?productId=${pid}&batchId=${bid}`
      );
      setSummary(r.data ?? null);
      setSummaryError('');
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : 'Failed to load stock summary');
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadCapacity = useCallback(async (pid: number) => {
    if (!pid) {
      setCapacity(null);
      return;
    }
    const reqId = ++capacityReqRef.current;
    try {
      const r = await api<{ data: BatchCapacityRow[] }>(
        `/api/qr/packing/batch-capacity?productId=${pid}`
      );
      const map: Record<number, BatchCapacityRow> = {};
      for (const c of r.data ?? []) map[num(c.batchId)] = c;
      if (reqId === capacityReqRef.current) setCapacity(map);
    } catch {
      if (reqId === capacityReqRef.current) setCapacity(null);
    }
  }, []);

  useEffect(() => {
    if (productId && batchId) {
      const batch = batches.find((b) => num(b.id) === batchId);
      // Guard against a stale batch left over from a previously selected product
      // (e.g. right after switching products, before the batch list reloads).
      if (!batch || num(batch.productId ?? batch.product_id) !== productId) {
        setSummary(null);
        return;
      }
      void loadSummary(productId, batchId);
    } else {
      setSummary(null);
    }
  }, [productId, batchId, batches, loadSummary]);

  useEffect(() => {
    if (productId) void loadCapacity(productId);
  }, [productId, loadCapacity]);

  useEffect(() => {
    // A different product or batch invalidates generated QRs and the open carton.
    setGenerated([]);
    setScanned([]);
    setCarton(null);
    setSpool(null);
    setSpoolKind('REAM');
  }, [productId, batchId]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      if (flashMsgTimer.current) window.clearTimeout(flashMsgTimer.current);
    };
  }, []);

  useEffect(() => {
    if (scanFlash) scanRef.current?.focus();
  }, [scanFlash]);

  useEffect(() => {
    if (products.length === 0) setShowNewProduct(true);
  }, [products.length]);

  const niimbotAvailable = useMemo(
    () => typeof window !== 'undefined' && !!window.Niimbot && window.Niimbot.isSupported(),
    []
  );

  const niimbotSerialAvailable = useMemo(
    () => typeof window !== 'undefined' && !!window.NiimbotSerial && window.NiimbotSerial.isSupported(),
    []
  );

  // Count USB ports this browser already has permission for (skip-the-chooser hint).
  useEffect(() => {
    if (!niimbotSerialAvailable) return;
    let alive = true;
    window.NiimbotSerial?.getPorts()
      .then((ports) => {
        if (alive) setUsbPaired(Array.isArray(ports) ? ports.length : 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [niimbotSerialAvailable]);

  const reamProducts = useMemo(() => products, [products]);
  const selectedProduct = reamProducts.find((p) => num(p.id) === productId);
  const selectedBatch = batches.find((b) => num(b.id) === batchId);
  const selectedBatchCap = batchId ? capacity?.[batchId] ?? null : null;
  const maxGenerate = useMemo(() => {
    const planned = num(summary?.plannedQty);
    if (planned > 0) return Math.max(0, num(summary?.remainingToGenerate));
    return 100;
  }, [summary]);
  const reamTemplates = useMemo(
    () => templates.filter((t) => t.kind === 'REAM' && t.isActive !== false),
    [templates]
  );
  const cartonTemplates = useMemo(
    () => templates.filter((t) => t.kind === 'CARTON' && t.isActive !== false),
    [templates]
  );
  const spoolTemplate = useMemo(() => {
    const list = spoolKind === 'REAM' ? reamTemplates : cartonTemplates;
    return list.find((t) => num(t.id) === spoolTemplateId) ?? null;
  }, [spoolKind, spoolTemplateId, reamTemplates, cartonTemplates]);

  const createProduct = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (productBusy) return;
    setProductBusy(true);
    setProductError('');
    setProductMsg('');
    try {
      const name = newProduct.name.trim();
      if (!name) throw new Error('Product name is required');
      const body: Record<string, unknown> = {
        type: 'REAM',
        name,
        gsm: newProduct.gsm ? Number(newProduct.gsm) : null,
        sheetsPerReam: newProduct.sheetsPerReam ? Number(newProduct.sheetsPerReam) : null,
        widthMm: newProduct.widthMm ? Number(newProduct.widthMm) : null,
      };
      const r = await api<{ data: ProductRow }>('/api/inventory/items', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const created = r.data;
      setProducts((prev) => [created, ...prev]);
      if (created && num(created.id)) setProductId(num(created.id));
      setNewProduct({ name: '', gsm: '', sheetsPerReam: '', widthMm: '' });
      setShowNewProduct(false);
      setProductMsg('Product created: ' + str(created.code) + ' - ' + str(created.name));
    } catch (err) {
      setProductError(err instanceof Error ? err.message : 'Product creation failed');
    } finally {
      setProductBusy(false);
    }
  };

  const createBatch = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!productId || batchBusy) return;
    setBatchBusy(true);
    setBatchError('');
    setBatchMsg('');
    try {
      const body: Record<string, unknown> = { productId };
      if (newBatch.quantity) body.quantity = Number(newBatch.quantity);
      if (newBatch.lotNo.trim()) body.lotNo = newBatch.lotNo.trim();
      if (newBatch.expiryDate) body.expiryDate = newBatch.expiryDate;
      if (newBatch.notes.trim()) body.notes = newBatch.notes.trim();
      const r = await api<{ data: BatchRow }>('/api/qr/batches', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const created = r.data;
      setBatches((prev) => [created, ...prev]);
      if (created && num(created.id)) setBatchId(num(created.id));
      setBatchMsg('Production batch created: ' + str(created.batchNo ?? created.batch_no));
      setNewBatch({ quantity: '', lotNo: '', expiryDate: '', notes: '' });
      setShowNewBatch(false);
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : 'Batch creation failed');
    } finally {
      setBatchBusy(false);
    }
  };

  const generate = async () => {
    if (!productId || !batchId || genBusy) return;
    setGenBusy(true);
    setGenError('');
    setGenWarn('');
    setSpool(null);
    try {
      const requestedCount = Math.max(1, Math.min(maxGenerate || 100, count));
      const r = await api<{ data: ReamGeneratedRow[] }>('/api/qr/reams/generate', {
        method: 'POST',
        body: JSON.stringify({ productId, batchId: batchId || null, count: requestedCount }),
      });
      const made = r.data?.length ?? 0;
      setGenerated(r.data ?? []);
      if (made < requestedCount) {
        setGenWarn(
          `Only ${made} of ${requestedCount} reams could be generated - the batch has ${num(summary?.remainingToGenerate)} reams left to its planned capacity.`
        );
      }
      if (made > 0) {
        setCount(made);
        showFlash(
          `Generated ${made} ream${made === 1 ? '' : 's'} for BATCH ${
            str(selectedBatch ? (selectedBatch.batchNo ?? selectedBatch.batch_no) : '')
          }`
        );
      }
      if (productId && batchId) void loadSummary(productId, batchId);
      if (productId) void loadCapacity(productId);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenBusy(false);
    }
  };

  const printReamLabels = async () => {
    if (generated.length === 0 || spoolBusy) return;
    setSpoolBusy(true);
    setSpoolError('');
    try {
      const items = generated.map((g) => ({ qrId: num(g.qrId), payload: str(g.payload) }));
      const body: Record<string, unknown> = { items };
      if (reamTemplateId) body.templateId = reamTemplateId;
      const r = await api<{ data: SpoolResult }>('/api/qr/labels/spool', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const s = r.data ?? null;
      setSpool(s);
      setSpoolKind('REAM');
      setSpoolTemplateId(reamTemplateId);
      showFlash(`Queued ${s?.labels?.length ?? 0} ream label(s) for printing (job ${str(s?.jobNo)})`);
    } catch (e) {
      setSpoolError(e instanceof Error ? e.message : 'Spool failed');
    } finally {
      setSpoolBusy(false);
    }
  };

  const scanReam = async (raw: string) => {
    const code = raw.trim();
    if (!code || scanBusy) return;
    setScanBusy(true);
    setScanError('');
    setScanInput('');
    try {
      if (scanned.some((s) => s.code === code)) {
        setScanError('Ream already scanned into this carton');
        return;
      }
      if (scanned.length >= REAMS_PER_CARTON) {
        setScanError(`A carton holds exactly ${REAMS_PER_CARTON} reams - seal it first`);
        return;
      }
      const r = await api<{ data: { result: string; ream: { reamNo?: string; status?: string } } }>(
        '/api/qr/packing/scan',
        { method: 'POST', body: JSON.stringify({ code }) }
      );
      if (r.data?.result !== 'AUTHENTIC') {
        setScanError(`Scan not authentic: ${str(r.data?.result)}`);
        return;
      }
      setScanned((prev) => [
        ...prev,
        { code, reamNo: str(r.data?.ream?.reamNo ?? code), status: str(r.data?.ream?.status ?? '') },
      ]);
      setScanFlash(`Scan OK - ${str(r.data?.ream?.reamNo ?? code)} added (${scanned.length + 1}/${REAMS_PER_CARTON})`);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setScanFlash(''), 2500);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setScanBusy(false);
      scanRef.current?.focus();
    }
  };

  const removeScanned = (idx: number) => {
    setScanned((prev) => prev.filter((_, i) => i !== idx));
    setScanError('');
    scanRef.current?.focus();
  };

  const seal = async () => {
    if (scanned.length !== REAMS_PER_CARTON || !productId || !batchId || sealBusy) return;
    setSealBusy(true);
    setSealError('');
    try {
      const r = await api<{ data: CartonResult }>('/api/qr/packing/seal', {
        method: 'POST',
        body: JSON.stringify({ productId, batchId: batchId || null, reamCodes: scanned.map((s) => s.code) }),
      });
      const c = r.data ?? null;
      setCarton(c);
      setScanned([]);
      showFlash(`Carton ${str(c?.cartonNo ?? c?.carton_no)} sealed with ${REAMS_PER_CARTON} reams`);
      window.setTimeout(() => cartonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
      if (productId && batchId) void loadSummary(productId, batchId);
      if (productId) void loadCapacity(productId);
    } catch (e) {
      setSealError(e instanceof Error ? e.message : 'Sealing failed');
    } finally {
      setSealBusy(false);
      scanRef.current?.focus();
    }
  };

  const printCartonLabel = async () => {
    if (!carton || spoolBusy) return;
    setSpoolBusy(true);
    setSpoolError('');
    try {
      const body: Record<string, unknown> = {
        items: [{ qrId: num(carton.qrId), payload: str(carton.payload) }],
      };
      if (cartonTemplateId) body.templateId = cartonTemplateId;
      const r = await api<{ data: SpoolResult }>('/api/qr/labels/spool', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const s = r.data ?? null;
      setSpool(s);
      setSpoolKind('CARTON');
      setSpoolTemplateId(cartonTemplateId);
      showFlash(
        `Queued carton label for ${str(carton ? (carton.cartonNo ?? carton.carton_no) : '')} (job ${str(s?.jobNo)})`
      );
    } catch (e) {
      setSpoolError(e instanceof Error ? e.message : 'Spool failed');
    } finally {
      setSpoolBusy(false);
    }
  };

  const ackLabel = async (label: SpooledLabel, ok: boolean, reason?: string) => {
    try {
      if (ok) {
        await api(`/api/qr/labels/${label.id}/printed`, { method: 'POST' });
      } else {
        await api(`/api/qr/labels/${label.id}/failed`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason ?? 'Printer print failed' }),
        });
      }
    } catch {
      // Best-effort auditing - the server can still be reconciled via GET /api/qr/labels/spool.
    }
  };

  const printSpoolWithDriver = async (
    driver: NonNullable<typeof window.Niimbot> | NonNullable<typeof window.NiimbotSerial> | undefined,
    transport: 'Bluetooth' | 'USB',
    setBusy: (b: boolean) => void,
    setStatus: (s: string) => void,
    setError: (s: string) => void,
    unavailableHint: string
  ) => {
    if (!spool) return;
    if (!driver || !driver.isSupported()) {
      setError(unavailableHint);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (transport === 'USB') {
        const sdrv = driver as NonNullable<typeof window.NiimbotSerial>;
        const granted = await sdrv.getPorts();
        if (!granted || granted.length === 0) {
          setStatus('Select your Niimbot printer in the USB chooser...');
          await sdrv.requestPort();
          setUsbPaired(1);
        } else {
          setStatus('Connecting to the paired USB printer...');
        }
      } else {
        setStatus('Select your Niimbot printer in the Bluetooth chooser...');
      }
      await driver.connect();
      const printer = driver.printer;
      if (!printer || printer.modelId == null) {
        throw new Error('Could not identify the printer - power it on, connect it, and try again.');
      }
      const model = NIIMBOT_MODELS[printer.modelId];
      if (!model) {
        throw new Error(`${printer.label} (model id ${printer.modelId}) is not supported yet - use the bridge daemon instead.`);
      }
      const fallback = LABEL_DIMS[spoolKind];
      const tpl = spoolTemplate;
      const dims =
        tpl && tpl.mmWidth && tpl.mmHeight
          ? {
              key: tpl.code,
              label: `${tpl.name} (${tpl.mmWidth}x${tpl.mmHeight}mm)`,
              mmW: Number(tpl.mmWidth),
              mmH: Number(tpl.mmHeight),
            }
          : fallback;
      const size = {
        key: dims.key,
        label: dims.label,
        w_px: mmToPx(dims.mmW, model.dpi),
        h_px: mmToPx(dims.mmH, model.dpi),
        dpi: model.dpi,
      };
      const urls = spool.labels.map((l) => l.imageDataUrl).filter((u): u is string => !!u);
      if (urls.length !== spool.labels.length) {
        throw new Error('Some labels have no image data - re-spool them or use the bridge daemon.');
      }
      setStatus(
        `Connected to ${printer.label}. Printing ${urls.length} label(s) (${size.w_px}x${size.h_px}px, ${dims.label})...`
      );
      await driver.printBatch(urls, {
        model,
        size,
        onProgress: (s) => setStatus(s),
      });
      for (const label of spool.labels) await ackLabel(label, true);
      setStatus(`Printed and acknowledged ${spool.labels.length} label(s).`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : `${transport} print failed`;
      setError(msg);
      for (const label of spool.labels) await ackLabel(label, false, msg.slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  const printSpoolViaBluetooth = () =>
    printSpoolWithDriver(
      window.Niimbot,
      'Bluetooth',
      setBtBusy,
      setBtStatus,
      setBtError,
      'Web Bluetooth is unavailable in this browser. Use Chrome or Edge on HTTPS (localhost works), or start the bridge daemon: npm run niimbot:bridge -w apps/api.'
    );

  const printSpoolViaUsb = () =>
    printSpoolWithDriver(
      window.NiimbotSerial,
      'USB',
      setUsbBusy,
      setUsbStatus,
      setUsbError,
      'Web Serial is unavailable in this browser. Use Chrome or Edge on HTTPS (localhost works) with the Niimbot plugged in via USB, or start the bridge daemon: npm run niimbot:bridge -w apps/api.'
    );

  // USB discovery: opens the chooser once, stores the port, then identifies the printer.
  const usbConnect = async (forceChooser: boolean) => {
    const driver = window.NiimbotSerial;
    if (!driver || !driver.isSupported()) {
      setDiscoverError('Web Serial is unavailable in this browser. Use Chrome or Edge on HTTPS (localhost works), with the Niimbot plugged in via USB.');
      return;
    }
    setDiscovered(null);
    setDiscoverStatus('');
    setDiscoverError('');
    setUsbBusy(true);
    try {
      const granted = await driver.getPorts();
      const paired = Array.isArray(granted) && granted.length > 0;
      if (forceChooser || !paired) {
        setDiscoverStatus(paired ? 'Pick the USB printer to use...' : 'Select your Niimbot printer in the USB chooser...');
        await driver.requestPort();
        setUsbPaired(1);
        setDiscoverStatus('Connecting to the selected USB printer...');
      } else {
        setDiscoverStatus('Found a previously paired USB printer - connecting...');
      }
      await driver.connect();
      const p = driver.printer;
      if (!p || p.modelId == null) {
        throw new Error('The USB device opened but did not identify as a Niimbot printer. Power the printer on, reseat the USB cable, then retry. If it still fails, enable "USB debug logs" and check the browser console (F12).');
      }
      const detail = p.deviceName && p.deviceName !== 'USB serial' ? p.deviceName : '';
      const name = p.label && p.label !== 'unknown' ? p.label : 'Niimbot USB printer';
      setDiscovered({ transport: 'USB', name, detail });
      setDiscoverStatus('Identified ' + name + (detail ? ' (' + detail + ')' : '') + ' - USB ready. It will be reused for printing without opening the chooser again.');
      await driver.disconnect().catch(() => undefined);
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'USB discovery failed';
      setDiscoverError(
        /No port selected|NotFoundError|not found/i.test(raw)
          ? 'No USB printer selected - the chooser was closed. Plug in the Niimbot (CH340/CH9102 USB) and try again.'
          : raw
      );
    } finally {
      setUsbBusy(false);
    }
  };

  const reconnectUsb = () => void usbConnect(false);

  const toggleUsbDebug = () => {
    const next = !usbDebug;
    setUsbDebug(next);
    if (window.NiimbotSerial) window.NiimbotSerial.DEBUG = next;
  };

  const discoverPrinter = async (transport: 'Bluetooth' | 'USB') => {
    setDiscovered(null);
    setDiscoverStatus('');
    setDiscoverError('');
    if (transport === 'Bluetooth') {
      const driver = window.Niimbot;
      if (!driver || !driver.isSupported()) {
        setDiscoverError('Web Bluetooth is unavailable in this browser. Use Chrome or Edge on HTTPS (localhost works).');
        return;
      }
      setBtBusy(true);
      setDiscoverStatus('Select your Niimbot printer in the Bluetooth chooser...');
      try {
        await driver.connect();
        const p = driver.printer;
        const name = p?.label ?? 'Niimbot printer';
        setDiscovered({ transport, name });
        await driver.disconnect().catch(() => undefined);
      } catch (e) {
        setDiscoverError(e instanceof Error ? e.message : 'Bluetooth discovery failed');
      } finally {
        setBtBusy(false);
      }
    } else {
      await usbConnect(true);
    }
  };

  if (loading) return <PageLoader label="Loading ream products..." />;
  if (error) return <ErrorBanner error={error} />;

  const resetFlow = () => {
    const hasWork = generated.length > 0 || scanned.length > 0 || !!carton || !!spool;
    if (
      hasWork &&
      !window.confirm('Clear the current packing flow? Generated reams, scans and the open carton will be reset.')
    ) {
      return;
    }
    setGenerated([]);
    setScanned([]);
    setCarton(null);
    setSpool(null);
    setSpoolKind('REAM');
    setGenError('');
    setScanError('');
    setSealError('');
    setSpoolError('');
    setScanFlash('');
    setFlashMsg('');
    if (productId && batchId) void loadSummary(productId, batchId);
    if (productId) void loadCapacity(productId);
    scanRef.current?.focus();
  };


  const reamSpooled = !!spool && spoolKind === 'REAM';

  const gotoStep = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const nextHint = (() => {
    if (!batchId) return 'Select or create a production batch in step 1 to start packing.';
    const batchNo = str(selectedBatch ? (selectedBatch.batchNo ?? selectedBatch.batch_no) : '');
    const plannedQty = num(summary?.plannedQty);
    if (plannedQty > 0 && num(summary?.remainingToGenerate) <= 0) {
      return 'Batch ' + batchNo + ' is at full planned capacity (' + plannedQty + ' reams). Create a new production batch in step 1 to keep packing.';
    }
    if (generated.length === 0) {
      return 'Generate reams for batch ' + batchNo + ' - stock is posted to FG as each ream is generated.';
    }
    if (!reamSpooled) return 'Spool the ream labels, then print them from the label queue before scanning.';
    if (scanned.length < REAMS_PER_CARTON) {
      const left = REAMS_PER_CARTON - scanned.length;
      return 'Scan ' + left + ' more ream' + (left === 1 ? '' : 's') + ' to complete carton #' + (num(summary?.cartonsSealed) + 1) + '.';
    }
    if (!carton) return 'Carton is full - seal it now, then print the carton label.';
    return 'Carton sealed. Start the next carton, or create a new batch once capacity is reached.';
  })();

  const steps = [
    { label: 'Product & batch', target: 'pack-step-1', done: !!batchId, active: !batchId },
    {
      label: 'Generate reams',
      target: 'pack-step-2',
      done: generated.length > 0,
      active: !!batchId && generated.length === 0 && !(num(summary?.plannedQty) > 0 && num(summary?.remainingToGenerate) <= 0),
    },
    {
      label: 'Print ream labels',
      target: 'pack-step-2',
      done: reamSpooled,
      active: generated.length > 0 && !reamSpooled,
    },
    {
      label: 'Scan reams',
      target: 'pack-step-3',
      done: scanned.length === REAMS_PER_CARTON,
      active: generated.length > 0 && scanned.length > 0 && scanned.length < REAMS_PER_CARTON,
    },
    {
      label: 'Seal & carton label',
      target: 'pack-step-3',
      done: !!carton,
      active: scanned.length === REAMS_PER_CARTON && !carton,
    },
  ];

  const readyToSeal = scanned.length === REAMS_PER_CARTON;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Ream Packing</h1>
          <p className="muted">Generate unique ream QRs, pack 5 reams into one carton and seal it.</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={resetFlow}
          title="Clear generated QRs, scanned reams and the open carton"
        >
          Start over
        </button>
      </header>

      <nav className="steps" aria-label="Packing flow">
        {steps.map((s, i) => {
          const status = s.done ? 'Done' : s.active ? 'In progress' : 'Pending';
          return (
            <button
              type="button"
              key={s.label}
              className={'step' + (s.active ? ' is-active' : '') + (s.done ? ' is-done' : '')}
              aria-current={s.active ? 'step' : undefined}
              title={'Go to: ' + s.label}
              onClick={() => gotoStep(s.target)}
            >
              <span className="step-num">{s.done ? '\u2713' : i + 1}</span>
              <span className="step-label">
                <span className="step-label-text">{s.label}</span>
                <span className="step-status">{status}</span>
              </span>
            </button>
          );
        })}
      </nav>

      {nextHint && (
        <div className="next-hint" role="status">
          <span className="next-hint-label">Next</span>
          <span className="next-hint-text">{nextHint}</span>
        </div>
      )}

      {flashMsg && (
        <div className="flash-ok toast" role="status" aria-live="polite">
          {flashMsg}
        </div>
      )}

      {summary && (
        <section className="card stock-panel">
          <div className="card-head">
            <h3>Stock &amp; flow</h3>
            {num(summary.plannedQty) > 0 ? (
              <span className="badge badge-info">
                {num(summary.generatedQty)}/{num(summary.plannedQty)} produced
              </span>
            ) : (
              <span className="badge badge-neutral">No planned target</span>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title="Refresh stock & flow"
              disabled={summaryLoading}
              onClick={() => {
                if (productId && batchId) void loadSummary(productId, batchId);
              }}
            >
              {summaryLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
          <div className="card-pad">
            <div className="stock-grid">
              <div className="kpi-card stock-kpi">
                <span className="kpi-label">On hand</span>
                <span className="kpi-value">{num(summary.onHand)}</span>
                <span className="kpi-sub">reams in FG stock</span>
              </div>
              <div className="kpi-card stock-kpi">
                <span className="kpi-label">Loose reams</span>
                <span className="kpi-value">{num(summary.looseReams)}</span>
                <span className="kpi-sub">available to pack</span>
              </div>
              <div className="kpi-card stock-kpi">
                <span className="kpi-label">Packed reams</span>
                <span className="kpi-value">{num(summary.packedReams)}</span>
                <span className="kpi-sub">inside sealed cartons</span>
              </div>
              <div className="kpi-card stock-kpi">
                <span className="kpi-label">Cartons sealed</span>
                <span className="kpi-value">{num(summary.cartonsSealed)}</span>
                <span className="kpi-sub">{num(summary.cartonsSealed) * REAMS_PER_CARTON} reams packed</span>
              </div>
            </div>
            {num(summary.plannedQty) > 0 && (
              <div className="progress-block">
                <div className="progress-labels">
                  <span>Batch production progress</span>
                  <span className="cell-mono">
                    {num(summary.generatedQty)} / {num(summary.plannedQty)} reams
                  </span>
                </div>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={num(summary.plannedQty)}
                  aria-valuenow={num(summary.generatedQty)}
                >
                  <div
                    className="progress-fill"
                    style={{
                      width:
                        Math.min(100, Math.round((num(summary.generatedQty) / Math.max(1, num(summary.plannedQty))) * 100)) + '%',
                    }}
                  />
                </div>
                <p className="muted progress-hint">
                  {num(summary.remainingToGenerate) > 0
                    ? `${num(summary.remainingToGenerate)} reams remaining to planned capacity`
                    : 'Planned capacity reached - create a new batch to produce more.'}
                </p>
              </div>
            )}
            {summaryError && <div className="alert alert-error" style={{ marginTop: 10 }}>{summaryError}</div>}
          </div>
        </section>
      )}

      <section className="card" id="pack-step-1">
        <div className="card-head"><h3>1 · Product & batch</h3></div>
        <div className="card-pad">
          <label className="field">
            <span>Ream product</span>
            <select value={productId} onChange={(e) => setProductId(num(e.target.value))}>
              {reamProducts.length === 0 && <option value={0}>No ream products - create one below</option>}
              {reamProducts.map((p) => (
                <option key={num(p.id)} value={num(p.id)}>
                  {str(p.code)} · {str(p.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginTop: 10 }}>
            <span>Production batch</span>
            <select value={batchId} onChange={(e) => setBatchId(num(e.target.value))} disabled={batches.length === 0}>
              {batches.length === 0 && <option value={0}>No batches yet - create one below</option>}
              {batches.map((b) => {
                const cap = capacity ? capacity[num(b.id)] : null;
                const full = !!cap?.capacityReached;
                return (
                  <option key={num(b.id)} value={num(b.id)} disabled={full}>
                    {str(b.batchNo ?? b.batch_no)}
                    {cap && num(cap.plannedQty) > 0
                      ? ` · ${num(cap.generatedQty)}/${num(cap.plannedQty)} reams` + (full ? ' · FULL' : '')
                      : null}
                  </option>
                );
              })}
            </select>
            {selectedBatchCap && num(selectedBatchCap.plannedQty) > 0 && (
              <span className="muted" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                {selectedBatchCap.capacityReached
                  ? 'This batch is at full planned capacity - create a new batch to produce more.'
                  : `${num(selectedBatchCap.remainingToGenerate)} of ${num(selectedBatchCap.plannedQty)} reams remain before this batch reaches capacity.`}
              </span>
            )}
          </label>
          {(selectedProduct || selectedBatch) && (
            <div className="chips" style={{ marginTop: 10 }}>
              {selectedProduct && (
                <span className="chip">
                  <span className="chip-k">Product</span>
                  <b>{str(selectedProduct.name)}</b>
                  <span className="cell-mono">{str(pick(selectedProduct, 'code'))}</span>
                  {str(pick(selectedProduct, 'gsm')) ? <span className="chip-k">{str(pick(selectedProduct, 'gsm'))} gsm</span> : null}
                </span>
              )}
              {selectedBatch && (
                <span className="chip">
                  <span className="chip-k">Batch</span>
                  <b className="cell-mono">{str(selectedBatch.batchNo ?? selectedBatch.batch_no)}</b>
                  {str(selectedBatch.lotNo ?? selectedBatch.lot_no) ? (
                    <span className="chip-k">Lot {str(selectedBatch.lotNo ?? selectedBatch.lot_no)}</span>
                  ) : null}
                  {summary ? (
                    <span className="chip-k">On hand {num(summary.onHand)}</span>
                  ) : null}
                  {str(selectedBatch.expiryDate ?? selectedBatch.expiry_date) ? (
                    <span className="chip-k">Exp {str(selectedBatch.expiryDate ?? selectedBatch.expiry_date)}</span>
                  ) : null}
                  <span className={'badge ' + (str(selectedBatch.status) === 'ACTIVE' ? 'badge-green' : 'badge-neutral')}>
                    {str(selectedBatch.status ?? 'ACTIVE')}
                  </span>
                </span>
              )}
            </div>
          )}
          {batchError && <div className="alert alert-error" style={{ marginTop: 8 }}>{batchError}</div>}
          {batchMsg && <div className="alert alert-success" style={{ marginTop: 8 }}>{batchMsg}</div>}

          <div className="flow-actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setShowNewBatch((v) => !v)}>
              {showNewBatch ? 'Hide batch form' : 'Create production batch'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setShowNewProduct((v) => !v)}>
              {showNewProduct ? 'Hide product form' : 'Create ream product'}
            </button>
          </div>

          {showNewBatch && (
            <form onSubmit={createBatch} className="stack" style={{ marginTop: 10 }}>
              <div className="grid-2">
                <label className="field">
                  <span>Quantity</span>
                  <input type="number" min={0} step={1} value={newBatch.quantity} onChange={(e) => setNewBatch({ ...newBatch, quantity: e.target.value })} placeholder="e.g. 1000 reams" />
                  <span className="muted" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                    Planned quantity - on-hand stock posts automatically as reams are generated and cartons are sealed.
                  </span>
                </label>
                <label className="field">
                  <span>Lot no</span>
                  <input value={newBatch.lotNo} onChange={(e) => setNewBatch({ ...newBatch, lotNo: e.target.value })} placeholder="Optional lot reference" />
                </label>
                <label className="field">
                  <span>Expiry date</span>
                  <input type="date" value={newBatch.expiryDate} onChange={(e) => setNewBatch({ ...newBatch, expiryDate: e.target.value })} />
                </label>
                <label className="field">
                  <span>Notes</span>
                  <input value={newBatch.notes} onChange={(e) => setNewBatch({ ...newBatch, notes: e.target.value })} placeholder="Optional batch notes" />
                </label>
              </div>
              <div className="flow-actions">
                <button className="btn btn-primary" disabled={batchBusy || !productId}>
                  {batchBusy ? 'Creating...' : 'Create batch'}
                </button>
              </div>
            </form>
          )}

          {showNewProduct && (
            <form onSubmit={createProduct} className="stack" style={{ marginTop: 10 }}>
              <div className="grid-2">
                <label className="field">
                  <span>Product name *</span>
                  <input value={newProduct.name} onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })} placeholder="e.g. A4 80gsm Copy Ream" />
                </label>
                <label className="field">
                  <span>GSM</span>
                  <input type="number" min={0} step="0.01" value={newProduct.gsm} onChange={(e) => setNewProduct({ ...newProduct, gsm: e.target.value })} placeholder="80" />
                </label>
                <label className="field">
                  <span>Sheets per ream</span>
                  <input type="number" min={1} step={1} value={newProduct.sheetsPerReam} onChange={(e) => setNewProduct({ ...newProduct, sheetsPerReam: e.target.value })} placeholder="500" />
                </label>
                <label className="field">
                  <span>Width (mm)</span>
                  <input type="number" min={0} step="0.1" value={newProduct.widthMm} onChange={(e) => setNewProduct({ ...newProduct, widthMm: e.target.value })} placeholder="210" />
                </label>
              </div>
              {productError && <div className="alert alert-error">{productError}</div>}
              <div className="flow-actions">
                <button className="btn btn-primary" disabled={productBusy || !newProduct.name.trim()}>
                  {productBusy ? 'Creating...' : 'Create product'}
                </button>
              </div>
            </form>
          )}
          {productMsg && <div className="alert alert-success" style={{ marginTop: 8 }}>{productMsg}</div>}
        </div>
      </section>


      <section className="card" id="pack-step-2">
        <div className="card-head">
          <h3>2 · Generate ream QRs</h3>
          {selectedBatch && <span className="cell-mono">BATCH {str(selectedBatch.batchNo ?? selectedBatch.batch_no)}</span>}
        </div>
        <div className="card-pad">
          <div className="packing-row">
            <label className="field">
              <span>Number of reams (1&ndash;{Math.max(1, maxGenerate)})</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, maxGenerate)}
                step={1}
                value={count}
                onChange={(e) => setCount(Math.min(Math.max(1, num(e.target.value)), Math.max(1, maxGenerate)))}
              />
              {num(summary?.plannedQty) > 0 && (
                <span className="muted" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  {maxGenerate > 0
                    ? `${maxGenerate} reams left in ${str(selectedBatch ? (selectedBatch.batchNo ?? selectedBatch.batch_no) : '')}`
                    : 'Batch planned capacity reached'}
                </span>
              )}
            </label>
            <div className="field packing-generate-btn">
              <span>&nbsp;</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!productId || !batchId || genBusy || maxGenerate <= 0}
                onClick={() => void generate()}
              >
                {genBusy ? 'Generating...' : maxGenerate <= 0 ? 'Capacity reached' : 'Generate reams'}
              </button>
            </div>
          </div>
          {!batchId && (
            <p className="muted" style={{ marginTop: 8 }}>
              Create a production batch in step 1 first - every ream QR label carries the batch number.
            </p>
          )}
          {genError && <div className="alert alert-error">{genError}</div>}
          {genWarn && <div className="alert alert-warn">{genWarn}</div>}
          {num(summary?.plannedQty) > 0 && num(summary?.remainingToGenerate) <= 0 && (
            <div className="alert alert-warn" role="alert" style={{ marginTop: 10 }}>
              This batch is full - create a new production batch in step 1 to generate more reams.
            </div>
          )}
          {generated.length > 0 && (
            <>
              <div className="packing-tray">
                <span>
                  <span className="badge badge-green">{generated.length} reams</span>{' '}
                  generated for <span className="cell-mono">BATCH {str(selectedBatch ? (selectedBatch.batchNo ?? selectedBatch.batch_no) : '')}</span>
                  <span className="muted"> - print the labels, then scan them on the packing line.</span>
                </span>
                <span className="packing-tray-actions">
                  <CopyButton value={str(generated[0].code)} label="Copy first QR" />
                  <CopyButton value={generated.map((g) => str(g.code)).join('\n')} label="Copy all QRs" />
                </span>
              </div>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="table data">
                  <thead>
                    <tr><th>Ream</th><th>QR code</th><th>Payload</th><th></th></tr>
                  </thead>
                  <tbody>
                    {generated.slice(0, 10).map((g) => (
                      <tr key={num(g.id)}>
                        <td className="cell-mono">{str(g.reamNo)}</td>
                        <td className="cell-mono">{str(g.code)}</td>
                        <td className="cell-mono" title="Secret payload - printed on the label only">{str(g.payload).split('|')[0]}|•••</td>
                        <td className="cell-num"><CopyButton value={str(g.code)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {templatesError && <div className="alert alert-error" style={{ marginTop: 10 }}>{templatesError}</div>}
              <div className="packing-row" style={{ marginTop: 12 }}>
                {reamTemplates.length > 0 && (
                  <label className="field">
                    <span>Ream label variety</span>
                    <select value={reamTemplateId} onChange={(e) => setReamTemplateId(num(e.target.value))}>
                      {reamTemplates.map((t) => (
                        <option key={num(t.id)} value={num(t.id)}>
                          {str(t.name)} ({str(t.mmWidth)}&times;{str(t.mmHeight)} mm)
                          {t.isDefault ? ' · Default' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button type="button" className="btn btn-primary" disabled={spoolBusy} onClick={() => void printReamLabels()}>
                  {spoolBusy ? 'Spooling...' : 'Spool & print ream labels (Niimbot)'}
                </button>
              </div>
            </>
          )}
        </div>
      </section>


      <section className="card" id="pack-step-3">
        <div className="card-head">
          <h3>3 · Packing line</h3>
          <span className={'badge ' + (readyToSeal ? 'badge-green' : 'badge-neutral')}>{scanned.length}/{REAMS_PER_CARTON} packed</span>
          {batchId && summary && (
            <span className="badge badge-blue">Carton {num(summary.cartonsSealed) + 1}</span>
          )}
        </div>
        <div className="card-pad">
          <div className="packing-slots" aria-label={scanned.length + ' of ' + REAMS_PER_CARTON + ' reams packed'}>
            {Array.from({ length: REAMS_PER_CARTON }).map((_, i) => (
              <span
                key={i}
                className={'packing-slot' + (i < scanned.length ? ' is-filled' : '') + (i === scanned.length && scanned.length < REAMS_PER_CARTON ? ' is-next' : '')}
              />
            ))}
            <span className="packing-slots-label">
              {readyToSeal ? 'Ready to seal' : scanned.length + '/' + REAMS_PER_CARTON + ' packed'}
            </span>
          </div>
          <form
            className="packing-scan-row"
            onSubmit={(e) => {
              e.preventDefault();
              void scanReam(scanInput);
            }}
          >
            <label className="field">
              <span>Scan ream QR</span>
              <input
                ref={scanRef}
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Scan or type the ream QR code"
                autoFocus
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={!scanInput.trim() || scanBusy}>
              {scanBusy ? 'Scanning...' : 'Scan ream'}
            </button>
          </form>
          {scanFlash && <div className="flash-ok" style={{ marginTop: 10 }} role="status" aria-live="polite">{scanFlash}</div>}
          {scanError && <div className="alert alert-error" style={{ marginTop: 10 }}>{scanError}</div>}

          {scanned.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table data">
                <thead>
                  <tr><th>#</th><th>Ream</th><th>QR code</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {scanned.map((s, i) => (
                    <tr key={s.code} className={i === scanned.length - 1 ? 'packing-row-fresh' : ''}>
                      <td>{i + 1}</td>
                      <td className="cell-mono">{s.reamNo}</td>
                      <td className="cell-mono">{s.code}</td>
                      <td>{s.status}</td>
                      <td className="cell-num">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost btn-ghost-danger"
                          title="Remove this ream from the carton"
                          onClick={() => removeScanned(i)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="packing-row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-success" disabled={!readyToSeal || !batchId || sealBusy} onClick={() => void seal()}>
              {sealBusy ? 'Sealing...' : 'Seal carton (5 reams)'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={scanned.length === 0}
              onClick={() => {
                setScanned([]);
                setScanError('');
              }}
            >
              Clear scans
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={scanned.length === 0}
              title="Remove the last scanned ream"
              onClick={() => removeScanned(scanned.length - 1)}
            >
              Undo last
            </button>
          </div>
          {batchId && !readyToSeal && (
            <p className="muted" style={{ marginTop: 8 }}>
              Scan {REAMS_PER_CARTON - scanned.length} more ream{REAMS_PER_CARTON - scanned.length === 1 ? '' : 's'} to unlock sealing.
            </p>
          )}
          {sealError && <div className="alert alert-error" style={{ marginTop: 8 }}>{sealError}</div>}

          {carton && (
            <div className="scan-verified" ref={cartonRef}>
              <div className="verify-mark">CARTON SEALED</div>
              <dl className="detail-list">
                <div className="detail-row"><dt>Carton no</dt><dd className="cell-mono">{str(carton.cartonNo ?? carton.carton_no)}</dd></div>
                <div className="detail-row"><dt>Carton QR</dt>
                  <dd><div className="copy-row"><span className="cell-mono">{str(carton.code)}</span><CopyButton value={str(carton.code)} /></div></dd>
                </div>
                <div className="detail-row"><dt>Payload</dt>
                  <dd><div className="copy-row"><span className="cell-mono">{str(carton.payload)}</span><CopyButton value={str(carton.payload)} /></div></dd>
                </div>
                <div className="detail-row"><dt>Reams</dt><dd>{Array.isArray(carton.reams) ? carton.reams.length : REAMS_PER_CARTON}</dd></div>
                {selectedBatch && (
                  <div className="detail-row"><dt>Batch</dt><dd className="cell-mono">{str(selectedBatch.batchNo ?? selectedBatch.batch_no)}</dd></div>
                )}
              </dl>
              {Array.isArray(carton.reams) && carton.reams.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table className="table data">
                    <thead>
                      <tr><th>#</th><th>Ream</th><th>QR code</th><th></th></tr>
                    </thead>
                    <tbody>
                      {carton.reams.map((r, i) => (
                        <tr key={num(r.reamId)}>
                          <td>{i + 1}</td>
                          <td className="cell-mono">{str(r.reamNo)}</td>
                          <td className="cell-mono">{str(r.code)}</td>
                          <td className="cell-num"><CopyButton value={str(r.code)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {templatesError && <div className="alert alert-error" style={{ marginTop: 10 }}>{templatesError}</div>}
              <div className="packing-row" style={{ marginTop: 12 }}>
                {cartonTemplates.length > 0 && (
                  <label className="field">
                    <span>Carton label variety</span>
                    <select value={cartonTemplateId} onChange={(e) => setCartonTemplateId(num(e.target.value))}>
                      {cartonTemplates.map((t) => (
                        <option key={num(t.id)} value={num(t.id)}>
                          {str(t.name)} ({str(t.mmWidth)}&times;{str(t.mmHeight)} mm)
                          {t.isDefault ? ' · Default' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button type="button" className="btn btn-primary" disabled={spoolBusy} onClick={() => void printCartonLabel()}>
                  {spoolBusy ? 'Spooling...' : 'Print carton label (Niimbot)'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>


      <section className="card">
        <div className="card-head">
          <h3>Printers & label spool</h3>
          {spool && (
            <span className="chip">
              <span className="chip-k">Job</span>
              <b className="cell-mono">{spool.jobNo}</b>
            </span>
          )}
        </div>
        <div className="card-pad">
          <div className="printer-strip" style={{ marginTop: 0 }}>
            <span className={'chip ' + (niimbotAvailable ? 'is-online' : '')}>
              <span className="chip-k">Bluetooth</span>
              {niimbotAvailable ? <b>Available</b> : <b>Unavailable</b>}
            </span>
            <span className={'chip ' + (niimbotSerialAvailable ? 'is-online' : '')}>
              <span className="chip-k">USB</span>
              {niimbotSerialAvailable ? <b>Available</b> : <b>Unavailable</b>}
            </span>
            {discovered && (
              <span className="chip is-online">
                <span className="chip-k">Found</span>
                <b>{discovered.name}</b>
                {discovered.detail && <span className="chip-k">{discovered.detail}</span>}
                <span className="chip-k">via {discovered.transport}</span>
              </span>
            )}
          </div>
          <div className="packing-row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={btBusy || usbBusy}
              onClick={() => void discoverPrinter('Bluetooth')}
            >
              {btBusy ? 'Searching...' : 'Discover Bluetooth printer'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={btBusy || usbBusy}
              onClick={() => void discoverPrinter('USB')}
            >
              {usbBusy ? 'Searching...' : usbPaired > 0 ? 'Change USB printer' : 'Discover USB printer'}
            </button>
            {usbPaired > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={btBusy || usbBusy}
                onClick={reconnectUsb}
              >
                {usbBusy ? 'Connecting...' : 'Reconnect USB printer'}
              </button>
            )}
            <button
              type="button"
              className={'btn btn-ghost' + (usbDebug ? ' btn-ghost-on' : '')}
              disabled={!niimbotSerialAvailable}
              onClick={toggleUsbDebug}
              title="Toggle [NiimbotSerial] debug logging to the browser console"
            >
              {usbDebug ? 'USB logs: ON' : 'USB debug logs'}
            </button>
            <span className="muted">Chrome/Edge on HTTPS or localhost - a previously paired printer reconnects without the chooser.</span>
          </div>
          {discoverStatus && <p className="muted" style={{ marginTop: 8 }}>{discoverStatus}</p>}
          {discoverError && <div className="alert alert-error" style={{ marginTop: 8 }}>{discoverError}</div>}
          {usbDebug && (
            <p className="muted" style={{ marginTop: 6 }}>
              USB debug logs are ON - open DevTools (F12) &rarr; Console and retry; lines are prefixed <code>[NiimbotSerial]</code>. Disable when done.
            </p>
          )}

          <div className="packing-divider" />
          {spoolError && <div className="alert alert-error" style={{ marginTop: 8 }}>{spoolError}</div>}

          {spool ? (
            <>
              <div className="packing-row">
                <span className="badge badge-blue">{spool.labels.length} label(s) queued</span>
                <span className="cell-mono">
                  {spoolTemplate && spoolTemplate.mmWidth && spoolTemplate.mmHeight
                    ? spoolTemplate.name + ' (' + spoolTemplate.mmWidth + 'x' + spoolTemplate.mmHeight + 'mm)'
                    : LABEL_DIMS[spoolKind].label}
                </span>
                {selectedBatch && (
                  <span className="cell-mono">BATCH {str(selectedBatch.batchNo ?? selectedBatch.batch_no)}</span>
                )}
              </div>
              {spool.labels.some((l) => l.imageDataUrl) && (
                <div className="packing-previews">
                  {spool.labels.map((l) => (
                    <figure key={l.id} className="packing-preview">
                      {l.imageDataUrl ? (
                        <img src={l.imageDataUrl} alt={'Label preview ' + l.code} />
                      ) : (
                        <div className="packing-preview-empty">No preview</div>
                      )}
                      <figcaption className="cell-mono">{str(l.labelNo)}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
              <div className="packing-row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!niimbotAvailable || btBusy}
                  onClick={() => void printSpoolViaBluetooth()}
                >
                  {btBusy ? 'Printing...' : 'Print via Bluetooth (Niimbot)'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!niimbotSerialAvailable || usbBusy}
                  onClick={() => void printSpoolViaUsb()}
                >
                  {usbBusy ? 'Printing...' : 'Print via USB (Niimbot)'}
                </button>
                {(!niimbotAvailable || !niimbotSerialAvailable) && (
                  <span className="muted">
                    Bluetooth/USB need Chrome or Edge on HTTPS or localhost - or run the bridge daemon (
                    <code>npm run niimbot:bridge -w apps/api</code>).
                  </span>
                )}
              </div>
              {btStatus && <p className="muted" style={{ marginTop: 8 }}>{btStatus}</p>}
              {btError && <div className="alert alert-error" style={{ marginTop: 8 }}>{btError}</div>}
              {usbStatus && <p className="muted" style={{ marginTop: 8 }}>{usbStatus}</p>}
              {usbError && <div className="alert alert-error" style={{ marginTop: 8 }}>{usbError}</div>}
            </>
          ) : (
            <div className="packing-empty">
              <p className="muted" style={{ margin: 0 }}>
                No labels spooled yet. Generate reams and spool them, or seal a carton - label previews and the
                Bluetooth/USB print buttons will appear here.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      title="Copy to clipboard"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
