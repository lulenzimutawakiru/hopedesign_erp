/**
 * Global types for the vendored niimbot-web-bluetooth v2.4.0 driver
 * (apps/web/public/vendor/niimbot.js -> window.Niimbot).
 */
export {};

declare global {
  interface Window {
    Niimbot?: NiimbotDriver;
    NiimbotSerial?: NiimbotSerialDriver;
  }
}

interface NiimbotPrinterInfo {
  modelId: number | null;
  protocolVersion: number | null;
  deviceName: string | null;
  label: string;
  task: string | null;
  dpi: number | null;
}

interface NiimbotPrintOptions {
  model?: NiimbotModelDef | undefined;
  size?: NiimbotSizeDef | undefined;
  copies?: number;
  onProgress?: (status: string) => void;
}

interface NiimbotDriver {
  VERSION: string;
  isSupported(): boolean;
  identify(model?: NiimbotModelDef | undefined): Promise<NiimbotPrinterInfo | null>;
  connect(model?: NiimbotModelDef | undefined): Promise<void>;
  disconnect(): Promise<void>;
  readonly printer: NiimbotPrinterInfo | null;
  printImage(url: string, opts: NiimbotPrintOptions): Promise<void>;
  printBatch(urls: string[], opts: NiimbotPrintOptions): Promise<void>;
}

/** Web Serial (USB) driver - apps/web/public/vendor/niimbot-serial.js -> window.NiimbotSerial. */
interface NiimbotSerialDriver {
  VERSION: string;
  DEBUG: boolean;
  readonly BAUD_RATE: number;
  isSupported(): boolean;
  /** Previously granted USB ports (no chooser) - for a "reconnect" hint. */
  getPorts(): Promise<NiimbotSerialPortInfo[]>;
  /** Force the native USB device chooser (discovery). */
  requestPort(): Promise<unknown>;
  connect(model?: NiimbotModelDef | undefined): Promise<NiimbotPrinterInfo | null>;
  disconnect(): Promise<void>;
  readonly printer: NiimbotPrinterInfo | null;
  /** Send one command, accept ANY response opcode (diagnostic). */
  probe(cmd: number, data?: number[], timeoutMs?: number): Promise<unknown>;
  identify(model?: NiimbotModelDef | undefined): Promise<NiimbotPrinterInfo | null>;
  printImage(url: string, opts: NiimbotPrintOptions): Promise<void>;
  printBatch(urls: string[], opts: NiimbotPrintOptions): Promise<void>;
}

interface NiimbotSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
  [key: string]: unknown;
}

/** Registry model entry (subset of niimbot-web-bluetooth registry.json). */
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

/** Label size entry (registry size + the two native ream/carton sizes). */
interface NiimbotSizeDef {
  key: string;
  label: string;
  w_px: number;
  h_px: number;
  dpi: number;
  offset_y_px?: number;
}
