import { useSyncExternalStore } from 'react';
import { safeMessage } from './states';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  /** Secondary line. Keep user-facing: never pass raw database or stack output. */
  body?: string;
  /** Milliseconds before auto-dismiss. 0 keeps the toast until dismissed. */
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastRecord extends ToastOptions {
  id: number;
  kind: ToastKind;
  title: string;
  createdAt: number;
}

const STACK_LIMIT = 4;
const DEFAULT_DURATION = 4800;

let seq = 0;
let records: ToastRecord[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, number>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ToastRecord[] {
  return records;
}

function clearTimer(id: number) {
  const handle = timers.get(id);
  if (handle !== undefined) {
    window.clearTimeout(handle);
    timers.delete(id);
  }
}

function dismiss(id: number) {
  clearTimer(id);
  const next = records.filter((t) => t.id !== id);
  if (next.length === records.length) return;
  records = next;
  emit();
}

function schedule(id: number, duration: number) {
  if (duration <= 0) return;
  clearTimer(id);
  timers.set(id, window.setTimeout(() => dismiss(id), duration));
}

function push(kind: ToastKind, title: string, options: ToastOptions = {}) {
  const duration = options.duration ?? (kind === 'error' ? 0 : DEFAULT_DURATION);
  const duplicate = records.find((t) => t.kind === kind && t.title === title && t.body === options.body);
  if (duplicate) {
    records = records.map((t) => (t.id === duplicate.id ? { ...t, createdAt: Date.now() } : t));
    schedule(duplicate.id, duration);
    emit();
    return duplicate.id;
  }
  const record: ToastRecord = { id: ++seq, kind, title, createdAt: Date.now(), ...options, duration };
  records = [...records, record].slice(-STACK_LIMIT);
  schedule(record.id, duration);
  emit();
  return record.id;
}

export const toast = {
  success: (title: string, options?: ToastOptions) => push('success', title, options),
  error: (title: string, options?: ToastOptions) => push('error', title, options),
  warning: (title: string, options?: ToastOptions) => push('warning', title, options),
  info: (title: string, options?: ToastOptions) => push('info', title, options),
  /** Shows the safe caller message, with the error detail appended only when it is presentable. */
  fromError: (title: string, error?: unknown) => {
    const detail = safeMessage(error);
    return push('error', title, detail ? { body: detail } : {});
  },
  dismiss,
  clear: () => {
    for (const id of Array.from(timers.keys())) clearTimer(id);
    records = [];
    emit();
  },
};

/** Imperative hook form, for components that prefer a hook-shaped call site. */
export function useToast() {
  return toast;
}

export function Toaster() {
  const items = useSyncExternalStore(subscribe, snapshot);
  if (!items.length) return null;
  return (
    <div className="toast-stack" role="region" aria-label="System notifications">
      {items.map((item) => (
        <div
          key={item.id}
          className={`toast toast-${item.kind}`}
          role={item.kind === 'error' ? 'alert' : 'status'}
          aria-live={item.kind === 'error' ? 'assertive' : 'polite'}
        >
          <span className="toast-rail" aria-hidden />
          <div className="toast-copy">
            <strong className="toast-title">{item.title}</strong>
            {item.body ? <span className="toast-body">{item.body}</span> : null}
          </div>
          {item.actionLabel && item.onAction ? (
            <button
              type="button"
              className="btn btn-sm toast-action"
              onClick={() => {
                item.onAction?.();
                dismiss(item.id);
              }}
            >
              {item.actionLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="toast-close"
            onClick={() => dismiss(item.id)}
            aria-label={`Dismiss notification: ${item.title}`}
          >
            {'\u2715'}
          </button>
        </div>
      ))}
    </div>
  );
}
