/*
 * Niimbot Serial driver (Web Serial / USB) - vendored for Hope OS.
 *
 * Implements the Niimbot label-printer wire protocol (frame V4:
 * 55 55 cmd len ...data crc AA AA) over the Web Serial API (navigator.serial),
 * so a Niimbot connected over USB can be discovered and printed straight from
 * the browser - no daemon, no drivers.
 *
 * The protocol and the print pipeline (job lifecycle, bitmap encoding, run
 * length, page-counter polling) are ported from niimbot-web-bluetooth v2.4.0
 * (MIT, https://github.com/iscarelli/niimbot-web-bluetooth) and its
 * protocol-v4.md documentation; only the transport differs (USB serial instead
 * of BLE GATT). The public API mirrors window.Niimbot so the app can treat USB
 * and BLE printers the same way.
 *
 * Requirements: Chrome/Edge on a secure context (HTTPS or localhost) and a
 * USB-connected Niimbot (CH340/CH9102 based adapters are supported by Web
 * Serial in Chromium).
 */
(function (root) {
  'use strict';

  const VERSION = '1.0.0';

  // Per-model behaviour - the same registry niimbot-web-bluetooth measured on
  // real hardware. `paced` = ~10 ms gap between row writes (the 203 dpi B1
  // drops rows on an unpaced burst); `bundle` = several frames may ride in one
  // write; `pagesPerJob: 1` = printer acks N pages but only prints the first,
  // so batches must be split into separate jobs.
  const MODEL_IDS = {
    4096: { label: 'Niimbot B1', task: 'b1', dpi: 203, paced: true, bundle: true },
    4097: { label: 'Niimbot B1 Pro', task: 'v4', dpi: 300, paced: false, bundle: false },
    4098: { label: 'Niimbot B1 SE', task: 'b1', dpi: 203, paced: true, bundle: false },
    4608: { label: 'Niimbot M2-H', task: 'b1', dpi: 300, paced: false, bundle: true },
    528: { label: 'Niimbot D11_H', task: 'v4', dpi: 300, paced: false, bundle: false },
    2304: { label: 'Niimbot D110', task: 'b1', dpi: 203, paced: true, bundle: false, pagesPerJob: 1 },
    6912: { label: 'Niimbot B2 Pro', task: 'v4', dpi: 300, paced: false, bundle: false },
    3586: { label: 'Niimbot N1', task: 'b1', dpi: 203, paced: true, bundle: false, pagesPerJob: 1 },
  };

  // Common USB-serial bridge chips found inside Niimbot printers (friendly names).
  const USB_IDS = {
    0x1a86: { 0x7523: 'CH340', 0x55d4: 'CH9102', 0x55d3: 'CH343' },
  };

  let DEBUG = false;
  let BAUD_RATE = 115200;   // Niimbot USB-serial default
  let PACE_MS = 10;
  let PAGE_WAIT_MS = 25000;
  const CONNECT_TIMEOUT_MS = 15000;
  const LOOKAHEAD = 2;

  let port = null;          // SerialPort
  let reader = null;        // ReadableStreamDefaultReader
  let writer = null;        // WritableStreamDefaultWriter
  let pending = null;       // { cmd, resolve } awaiting a response
  let lastUnsolicited = null;
  let printerInfo = null;
  let pacedOverride = null; // null (auto) | true | false - diagnostic knob

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function h2(cmd) { return '0x' + (cmd & 0xff).toString(16).padStart(2, '0'); }
  function logMsg(m) { if (DEBUG) console.log('[NiimbotSerial] ' + m); }
  function logTx(cmd, data) { if (DEBUG) console.log('[NiimbotSerial] TX ' + h2(cmd) + ' len=' + (data ? data.length : 0)); }
  function logRx(cmd, data) { if (DEBUG) console.log('[NiimbotSerial] RX ' + h2(cmd) + ' len=' + (data ? data.length : 0)); }
  function isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial &&
      typeof navigator.serial.getPorts === 'function' && typeof navigator.serial.requestPort === 'function';
  }

  // ---- Frame V4: [0x55,0x55,cmd,len,...data,crc,0xAA,0xAA], crc = cmd^len^data
  function pack(cmd, data) {
    data = data || [];
    const pkt = new Uint8Array(7 + data.length);
    pkt[0] = 0x55; pkt[1] = 0x55; pkt[2] = cmd; pkt[3] = data.length;
    let crc = cmd ^ data.length;
    for (let i = 0; i < data.length; i++) { pkt[4 + i] = data[i]; crc ^= data[i]; }
    pkt[4 + data.length] = crc & 0xff;
    pkt[5 + data.length] = 0xaa; pkt[6 + data.length] = 0xaa;
    return pkt;
  }

  // ---- Serial receive: accumulate bytes, extract frames, resync on garbage.
  let rxBuf = new Uint8Array(0);
  function dispatch(frame) {
    logRx(frame.cmd, frame.data);
    if (pending && (pending.cmd === frame.cmd || pending.cmd === null)) {
      const p = pending; pending = null;
      p.resolve(frame);
    } else {
      lastUnsolicited = frame;
    }
  }
  function feedRx(bytes) {
    const tmp = new Uint8Array(rxBuf.length + bytes.length);
    tmp.set(rxBuf); tmp.set(bytes, rxBuf.length);
    rxBuf = tmp;
    let i = 0;
    while (i + 6 < rxBuf.length) {
      if (rxBuf[i] !== 0x55 || rxBuf[i + 1] !== 0x55) { i++; continue; }
      const cmd = rxBuf[i + 2];
      const len = rxBuf[i + 3];
      const end = i + 4 + len + 3;   // data + crc + 0xAA 0xAA
      if (end > rxBuf.length) break; // frame incomplete - wait for more bytes
      if (rxBuf[end - 2] === 0xaa && rxBuf[end - 1] === 0xaa) {
        let crc = cmd ^ len;
        for (let j = 0; j < len; j++) crc ^= rxBuf[i + 4 + j];
        if ((crc & 0xff) === rxBuf[end - 3]) {
          const data = Array.prototype.slice.call(rxBuf.subarray(i + 4, i + 4 + len));
          dispatch({ cmd, data });
          i = end;
          continue;
        }
      }
      i++; // bad checksum/trailer: drop one byte and resync
    }
    rxBuf = rxBuf.subarray(i);
  }
  async function readLoop() {
    const r = port.readable.getReader();
    reader = r;
    try {
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        if (value && value.length) feedRx(value);
      }
    } catch (e) {
      logMsg('read loop stopped: ' + (e && e.message ? e.message : e));
    } finally {
      reader = null;
      try { r.releaseLock(); } catch (e) { /* ignore */ }
    }
  }

  // ---- Write path
  function effectivePaced() {
    if (pacedOverride != null) return pacedOverride;
    const meta = (printerInfo && printerInfo.modelId != null) ? MODEL_IDS[printerInfo.modelId] : null;
    const task = (meta && meta.task) || (printerInfo && printerInfo.task) || null;
    return meta ? !!meta.paced : task === 'b1';
  }
  async function writeRaw(bytes) {
    if (!port || !port.writable) throw new Error('Not connected - run connect() first.');
    if (!writer) writer = port.writable.getWriter();
    let last = null;
    for (let tries = 0; tries < 30; tries++) {
      try {
        await writer.write(bytes);
        if (effectivePaced()) await sleep(PACE_MS);
        return;
      } catch (e) {
        last = e;
        await sleep(4);
      }
    }
    throw new Error('Failed to write to serial port' + (last && last.message ? ': ' + last.message : ''));
  }
  function send(cmd, data) { logTx(cmd, data); return writeRaw(pack(cmd, data)); }

  // Frame bundling: multiple row frames in one write where the model tolerates it.
  let BUNDLE_MAX = 240;
  let _bundleAllowed = false;
  let _bundle = [];
  let _bundleLen = 0;
  async function flushBundle() {
    if (!_bundle.length) return;
    let out;
    if (_bundle.length === 1) out = _bundle[0];
    else {
      out = new Uint8Array(_bundleLen);
      let o = 0;
      for (const f of _bundle) { out.set(f, o); o += f.length; }
    }
    _bundle = []; _bundleLen = 0;
    await writeRaw(out);
  }
  async function sendBundled(cmd, data) {
    logTx(cmd, data);
    const frame = pack(cmd, data);
    const max = _bundleAllowed ? BUNDLE_MAX : 0;
    if (_bundleLen && _bundleLen + frame.length > Math.max(max, frame.length)) await flushBundle();
    _bundle.push(frame); _bundleLen += frame.length;
  }

  async function sendWait(cmd, data, wantResp, timeoutMs) {
    const wait = new Promise((resolve) => { pending = { cmd: wantResp, resolve }; });
    await send(cmd, data);
    const res = await Promise.race([wait, sleep(timeoutMs).then(() => null)]);
    if (pending && pending.cmd === wantResp) pending = null; // clear on timeout
    if (!res) logMsg('no response to ' + h2(cmd) + ' (wanted ' + (wantResp == null ? 'any' : h2(wantResp)) + ') after ' + timeoutMs + 'ms');
    return res; // { cmd, data } or null
  }

  async function getPrintStatus(timeoutMs) {
    lastUnsolicited = null;
    const wait = new Promise((resolve) => { pending = { cmd: 0xb3, resolve }; });
    await send(0xa3, [0x01]);
    const res = await Promise.race([wait, sleep(timeoutMs).then(() => null)]);
    if (pending && pending.cmd === 0xb3) pending = null;
    const r = res || (lastUnsolicited && lastUnsolicited.cmd === 0xb3 ? lastUnsolicited : null);
    if (!r || r.data.length < 4) return null;
    return { page: (r.data[0] << 8) | r.data[1], print: r.data[2], feed: r.data[3] };
  }

  // ---- Printer identification
  function portName() {
    try {
      const info = port && port.getInfo ? port.getInfo() : null;
      if (!info) return 'USB serial';
      const vid = info.usbVendorId;
      const pid = info.usbProductId;
      let chip = '';
      if (USB_IDS[vid] && USB_IDS[vid][pid]) chip = ' (' + USB_IDS[vid][pid] + ')';
      return 'USB ' + (vid != null ? vid.toString(16).padStart(4, '0') : '????') + ':' +
        (pid != null ? pid.toString(16).padStart(4, '0') : '????') + chip;
    } catch (e) {
      return 'USB serial';
    }
  }
  async function detectPrinter() {
    printerInfo = null;
    let modelId = null;
    let protocolVersion = null;
    const s = await sendWait(0xa5, [0x01], 0xb5, 1000);   // PrinterStatusData
    if (s && s.data.length >= 13) {
      const n = s.data[11] * 100 + s.data[12];
      protocolVersion = (n >= 204 && n < 300) ? 3 : (n >= 302 ? 5 : (n >= 300 ? 4 : 0));
    }
    const r = await sendWait(0x40, [0x08], 0x48, 1000);   // PrinterModelId (BE u16)
    if (r && r.data.length >= 1) {
      modelId = r.data.length >= 2 ? ((r.data[0] << 8) | r.data[1]) : (r.data[0] << 8);
    }
    const meta = (modelId != null && MODEL_IDS[modelId]) || null;
    printerInfo = {
      modelId, protocolVersion,
      deviceName: portName(),
      label: meta ? meta.label : (modelId != null ? 'unknown (id ' + modelId + ')' : 'unknown'),
      task: meta ? meta.task : null,
      dpi: meta ? meta.dpi : null,
    };
    logMsg('identified ' + printerInfo.label + ' (id=' + modelId + ', proto=' + protocolVersion + ', ' + printerInfo.deviceName + ')');
    return printerInfo;
  }

  function assertSelection(model, size) {
    if (!printerInfo || printerInfo.task == null) return;
    if (model && model.task && model.task !== printerInfo.task) {
      throw new Error('Connected printer is ' + printerInfo.label + ' (task "' + printerInfo.task + '", ' + printerInfo.dpi + ' dpi), but the selected model uses task "' + model.task + '". Select the ' + printerInfo.label + ' model (and a matching label size).');
    }
    if (size && size.dpi != null && printerInfo.dpi != null && size.dpi !== printerInfo.dpi) {
      throw new Error('Selected label size is ' + size.dpi + ' dpi but ' + printerInfo.label + ' prints at ' + printerInfo.dpi + ' dpi. Pick a ' + printerInfo.dpi + ' dpi size.');
    }
  }

  function densityFor(model, opts) {
    let raw = opts && opts.density != null ? opts.density : (model && model.density);
    if (raw == null) raw = 3;
    const d = Number(raw);
    if (!Number.isInteger(d) || d < 1 || d > 5) {
      throw new Error('density must be an integer 1-5 (got ' + JSON.stringify(raw) + ') - the scale the official app uses');
    }
    return d;
  }

  // ---- Bitmap: image -> rows packed MSB-first (1 = black), same as the BLE driver
  async function imageToPacked(url, w, h, offsetY) {
    const dy = offsetY | 0;
    const bmp = await fetch(url).then((r) => r.blob()).then((b) => createImageBitmap(b));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, dy, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const stride = (w + 7) >> 3;
    const buf = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (px[i + 3] > 32 && lum < 128) buf[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { buf, stride };
  }

  function rowEmpty(buf, off, stride) {
    for (let b = 0; b < stride; b++) if (buf[off + b]) return false;
    return true;
  }
  function popcountRow(buf, off, stride) {
    let n = 0;
    for (let b = 0; b < stride; b++) { let v = buf[off + b]; while (v) { n += v & 1; v >>= 1; } }
    return n;
  }
  // Row-by-row bitmap (both tasks), grouping identical rows (run-length):
  // 0x84 (empty) / 0x85 (with pixels, total mode [00, lo, hi], repeat).
  async function sendImage(buf, h, stride) {
    let r = 0;
    while (r < h) {
      const off = r * stride;
      const isVoid = rowEmpty(buf, off, stride);
      let run = 1;
      while (r + run < h && run < 200) {
        let same = true;
        const off2 = (r + run) * stride;
        for (let b = 0; b < stride; b++) if (buf[off + b] !== buf[off2 + b]) { same = false; break; }
        if (!same) break;
        run++;
      }
      if (isVoid) {
        await sendBundled(0x84, [(r >> 8) & 0xff, r & 0xff, run]);
      } else {
        const total = popcountRow(buf, off, stride);
        const data = new Array(6 + stride);
        data[0] = (r >> 8) & 0xff; data[1] = r & 0xff; data[2] = 0;
        data[3] = total & 0xff; data[4] = (total >> 8) & 0xff; data[5] = run;
        for (let b = 0; b < stride; b++) data[6 + b] = buf[off + b];
        await sendBundled(0x85, data);
      }
      r += run;
    }
    await flushBundle();
  }

  // ---- Job lifecycle (same sequence as the BLE driver)
  function isB1(model) { return model && model.task === 'b1'; }
  function connectedMeta() {
    return (printerInfo && printerInfo.modelId != null) ? MODEL_IDS[printerInfo.modelId] : null;
  }

  async function beginJob(model, totalPages, onProgress, density) {
    onProgress && onProgress('configuring...');
    await sendWait(0x21, [density], 0x31, 1000);             // SetDensity
    await sendWait(0x23, [model.label_type], 0x33, 1000);    // SetLabelType
    const n = Math.max(1, totalPages | 0);
    const start = isB1(model)
      ? [(n >> 8) & 0xff, n & 0xff, 0, 0, 0, 0, 0]                              // printStart 7b
      : [(n >> 8) & 0xff, n & 0xff, 0, 0, 0, 0, 0, model.speed, 0];             // printStart 9b
    await sendWait(0x01, start, 0x02, 2000);                 // PrintStart
  }

  async function sendPagePacked(model, size, buf, stride, copies, onProgress) {
    const W = size.w_px;
    const H = size.h_px;
    const c = Math.max(1, copies | 0);
    if (isB1(model)) {
      await sendWait(0x03, [0x01], 0x04, 1000);              // PageStart (B1 only)
      await sendWait(0x13, [
        (H >> 8) & 0xff, H & 0xff, (W >> 8) & 0xff, W & 0xff, (c >> 8) & 0xff, c & 0xff,
      ], 0x14, 2000);                                        // SetPageSize 6b (rows, cols, copies)
    } else {
      await send(0xa3, [0x01]); await sleep(30);             // PrintStatus (one-way)
      await sendWait(0x13, [
        (H >> 8) & 0xff, H & 0xff, (W >> 8) & 0xff, W & 0xff,
        (c >> 8) & 0xff, c & 0xff, 0, 0, 0, 0, 0, 0, 0,
      ], 0x14, 2000);                                        // SetPageSize 13b (copies)
    }
    onProgress && onProgress('sending image...');
    await sendImage(buf, H, stride);
    const pageEnd = await sendWait(0xe3, [0x01], 0xe4, 3000);  // PageEnd (0xE3)
    return pageEnd != null;
  }

  let _lastPage = -1;    // last printed-page counter seen (timing trace)
  let _pageSeen = null;  // last counter value observed by waitPage (error messages)
  async function waitPage(target, onProgress) {
    onProgress && onProgress('printing...');
    const t0 = Date.now();
    _pageSeen = null;
    while (Date.now() - t0 < PAGE_WAIT_MS) {
      const st = await getPrintStatus(900);
      if (st) {
        _pageSeen = st.page;
        if (st.page !== _lastPage) {
          logMsg('printer counter -> page ' + st.page + ' (print ' + st.print + '%, feed ' + st.feed + '%)');
          _lastPage = st.page;
        }
        onProgress && onProgress('printing... ' + st.print + '%');
        if (st.page >= target) return true;
      }
      await sleep(150);
    }
    return false;
  }

  function unconfirmed(reason) {
    return new Error('print not confirmed: ' + reason + '. PrintEnd was sent, so the paper has been fed out - check the labels, they may be blank, short or repeated.');
  }

  async function endJob() {
    await sendWait(0xf3, [0x01], 0xf4, 2500);                // PrintEnd (0xF3)
  }

  async function finishJob(model, target, onProgress) {
    const want = Math.max(1, target | 0);
    const reached = await waitPage(want, onProgress);
    await endJob();
    if (!reached) {
      throw unconfirmed('printer counter stopped at page ' + (_pageSeen == null ? '?' : _pageSeen) + ' of ' + want + ' after ' + PAGE_WAIT_MS + 'ms');
    }
  }

  // ---- Connection
  async function connect(portArg) {
    if (port && port.readable) return printerInfo;
    if (!isSupported()) {
      throw new Error('Web Serial unavailable - use Chrome/Edge over HTTPS or localhost with the Niimbot plugged in via USB.');
    }
    if (!port) {
      if (portArg && typeof portArg.open === 'function') {
        port = portArg;
      } else {
        const granted = await navigator.serial.getPorts();
        // Discovery: reconnect a previously granted port, otherwise show the chooser.
        port = granted.length ? granted[0] : await navigator.serial.requestPort();
      }
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('USB connect timed out after ' + CONNECT_TIMEOUT_MS + 'ms - the printer did not respond. Power it on, reseat the USB cable, then retry.')), CONNECT_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        (async () => {
          await port.open({ baudRate: BAUD_RATE });
          logMsg('opened ' + portName() + ' @ ' + BAUD_RATE + ' baud');
          pending = null; lastUnsolicited = null; printerInfo = null;
          _bundle = []; _bundleLen = 0; _bundleAllowed = false;
          readLoop(); // fire-and-forget; frames dispatch to pending
          // Initial connection packet (raw, 0x03 prefix - same as the BLE driver / niimblue).
          await writeRaw(new Uint8Array([0x03, 0x55, 0x55, 0xc1, 0x01, 0x01, 0xc1, 0xaa, 0xaa]));
          await sleep(200);
          await detectPrinter();   // identify B1 vs B1 Pro vs D110...
          const meta = (printerInfo && printerInfo.modelId != null) ? MODEL_IDS[printerInfo.modelId] : null;
          const task = (meta && meta.task) || (printerInfo && printerInfo.task) || null;
          _bundleAllowed = !!(meta && meta.bundle);
          if (task === 'b1') await b1Handshake();
        })(),
        timeout,
      ]);
    } catch (e) {
      const raw = (e && e.message) ? e.message : String(e);
      if (port && port.readable) {
        try { await disconnect(); } catch (e2) { /* ignore */ }
      } else {
        port = null;
      }
      if (raw.indexOf('timed out') !== -1 || raw.indexOf('did not respond') !== -1) throw e;
      throw new Error('USB connection failed: ' + raw + '. Power the printer on, reseat the cable, then retry - enable "USB debug logs" for details.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    return printerInfo;
  }

  async function b1Handshake() {
    logMsg('B1 handshake (status + info + heartbeat)');
    await sendWait(0xa5, [0x01], 0xb5, 1000);
    for (const sub of [0x08, 0x0b, 0x0d, 0x0a, 0x07, 0x03, 0x0c, 0x09]) {
      await sendWait(0x40, [sub], null, 600);   // PrinterInfo (response code varies)
    }
    await sendWait(0xdc, [0x04], 0xd9, 1000);   // Heartbeat
  }

  async function disconnect() {
    const p = port;
    port = null; pending = null; lastUnsolicited = null; printerInfo = null;
    _bundle = []; _bundleLen = 0; _bundleAllowed = false;
    if (!p) { logMsg('disconnected'); return; }
    try {
      if (reader) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        await sleep(30);   // let the read loop release its lock
      }
      if (writer) {
        try { writer.releaseLock(); } catch (e) { /* ignore */ }
        writer = null;
      }
      await p.close();
    } catch (e) {
      logMsg('disconnect: ' + (e && e.message ? e.message : e));
    }
    logMsg('disconnected');
  }

  // ---- Print entry points (ported from the BLE driver)
  async function printImage(url, opts) {
    opts = opts || {};
    const model = opts.model;
    const size = opts.size;
    const onProgress = opts.onProgress;
    const copies = Math.max(1, opts.copies | 0);
    const density = densityFor(model, opts);   // validate BEFORE touching the printer
    onProgress && onProgress('connecting...');
    await connect(model);
    assertSelection(model, size);
    const offsetY = opts.offsetY != null ? opts.offsetY : (size.offset_y_px || 0);
    const { buf, stride } = await imageToPacked(url, size.w_px, size.h_px, offsetY);
    _lastPage = -1; _pageSeen = null;
    const meta = connectedMeta();
    if (meta && meta.pagesPerJob === 1 && copies > 1) {
      for (let i = 0; i < copies; i++) {
        const tag = 'copy ' + (i + 1) + '/' + copies;
        _lastPage = -1; _pageSeen = null;
        await beginJob(model, 1, (s) => onProgress && onProgress(tag + ': ' + s), density);
        const acked = await sendPagePacked(model, size, buf, stride, 1, (s) => onProgress && onProgress(tag + ': ' + s));
        if (!acked) {
          await endJob();
          throw unconfirmed('the printer never acknowledged PageEnd for ' + tag);
        }
        await finishJob(model, 1, (s) => onProgress && onProgress(tag + ': ' + s));
      }
      onProgress && onProgress('ok');
      return;
    }
    await beginJob(model, copies, onProgress, density);
    const acked = await sendPagePacked(model, size, buf, stride, copies, onProgress);
    if (!acked) {
      await endJob();
      throw unconfirmed('the printer never acknowledged PageEnd for the image');
    }
    await finishJob(model, copies, onProgress);
    onProgress && onProgress('ok');
  }

  async function printBatch(urls, opts) {
    opts = opts || {};
    const model = opts.model;
    const size = opts.size;
    const onProgress = opts.onProgress;
    const density = densityFor(model, opts);
    onProgress && onProgress('connecting...');
    await connect(model);
    assertSelection(model, size);
    const N = urls.length;
    if (N === 0) { onProgress && onProgress('ok'); return; }
    const meta = connectedMeta();
    if (meta && meta.pagesPerJob === 1 && N > 1) {
      for (let i = 0; i < N; i++) {
        const tag = 'label ' + (i + 1) + '/' + N;
        onProgress && onProgress(tag + ': sending...');
        const { buf, stride } = await imageToPacked(urls[i], size.w_px, size.h_px, size.offset_y_px || 0);
        _lastPage = -1; _pageSeen = null;
        await beginJob(model, 1, (s) => onProgress && onProgress(tag + ': ' + s), density);
        const acked = await sendPagePacked(model, size, buf, stride, 1, (s) => onProgress && onProgress(tag + ': ' + s));
        if (!acked) {
          await endJob();
          throw unconfirmed('page ' + (i + 1) + ' of ' + N + ' was never acknowledged (no PageEnd ack)');
        }
        await finishJob(model, 1, (s) => onProgress && onProgress(tag + ': ' + s));
      }
      onProgress && onProgress('ok');
      return;
    }
    await beginJob(model, N, onProgress, density);
    let problem = null;
    for (let i = 0; i < N && !problem; i++) {
      const tag = 'label ' + (i + 1) + '/' + N;
      onProgress && onProgress(tag + ': sending...');
      const { buf, stride } = await imageToPacked(urls[i], size.w_px, size.h_px, size.offset_y_px || 0);
      const acked = await sendPagePacked(model, size, buf, stride, 1, (s) => onProgress && onProgress(tag + ': ' + s));
      if (!acked) {
        problem = 'page ' + (i + 1) + ' of ' + N + ' was never acknowledged (no PageEnd ack)';
        break;
      }
      if (i - LOOKAHEAD >= 0) {
        const want = i - LOOKAHEAD + 1;
        if (!await waitPage(want, (s) => onProgress && onProgress(tag + ': ' + s))) {
          problem = 'printer counter stalled at page ' + (_pageSeen == null ? '?' : _pageSeen) + ' of ' + want + ' while streaming (' + PAGE_WAIT_MS + 'ms)';
        }
      }
    }
    if (!problem && !await waitPage(N, onProgress)) {
      problem = 'printer counter stopped at page ' + (_pageSeen == null ? '?' : _pageSeen) + ' of ' + N + ' after ' + PAGE_WAIT_MS + 'ms';
    }
    // PrintEnd goes out either way - it is what feeds out and retracts the paper.
    await endJob();
    if (problem) throw unconfirmed(problem);
    onProgress && onProgress('ok');
  }

  // ---- Public API (mirrors window.Niimbot)
  root.NiimbotSerial = {
    VERSION,
    get DEBUG() { return DEBUG; }, set DEBUG(v) { DEBUG = !!v; },
    get BAUD_RATE() { return BAUD_RATE; },
    set BAUD_RATE(v) {
      const b = Number(v);
      if (!Number.isInteger(b) || b <= 0) throw new Error('BAUD_RATE must be a positive integer');
      BAUD_RATE = b;
    },
    get PACE_MS() { return PACE_MS; }, set PACE_MS(v) { PACE_MS = Math.max(0, v | 0); },
    get PAGE_WAIT_MS() { return PAGE_WAIT_MS; }, set PAGE_WAIT_MS(v) { PAGE_WAIT_MS = Math.max(1, v | 0); },
    // null (auto, per model) | true (force pacing) | false (force no pacing)
    get PACED() { return pacedOverride; }, set PACED(v) { pacedOverride = v == null ? null : !!v; },
    isSupported: () => isSupported(),
    // Previously granted USB ports (no chooser) - for a "reconnect" hint.
    getPorts: async () => {
      if (!isSupported()) return [];
      try {
        const granted = await navigator.serial.getPorts();
        return granted.map((p) => { try { return p.getInfo ? p.getInfo() : {}; } catch (e) { return {}; } });
      } catch (e) {
        return [];
      }
    },
    // Force the USB device chooser (discovery).
    requestPort: async () => {
      if (!isSupported()) throw new Error('Web Serial unavailable - use Chrome/Edge over HTTPS or localhost.');
      if (port && port.readable) {
        try { await disconnect(); } catch (e) { /* ignore */ }
      }
      port = await navigator.serial.requestPort();
      return port;
    },
    get printer() { return printerInfo; },
    connect,
    disconnect,
    // Send one command, accept ANY response opcode (diagnostic).
    probe: async (cmd, data, timeoutMs) => {
      if (!port || !port.readable) throw new Error('Not connected - probe needs an open connection.');
      return await sendWait(cmd, data || [], null, timeoutMs != null ? timeoutMs : 400);
    },
    identify: async (model) => { await connect(model); return printerInfo; },
    printImage,
    printBatch,
  };
})(typeof window !== 'undefined' ? window : globalThis);
