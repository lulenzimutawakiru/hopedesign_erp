import pg from 'pg';
import { Ctx, detach } from '../db.js';
import {
  notifyUsers,
  notifyCustomer,
  processNotificationDeliveries,
  resolveRecipients,
  type NotifyInput,
  type NotificationPriority,
} from './communication.js';

/**
 * Event → instant notification bridge.
 *
 * Every `emitEvent` call (the central event bus) is mirrored into the
 * communication pipeline so that module events surface immediately as
 * notifications (in-app, email, SMS, WhatsApp) to the relevant roles.
 * The bridge is intentionally fire-and-forget: it must never break the
 * business transaction that emitted the event.
 */

export type NotifySeverity = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

export interface EventSpec {
  /** Notification `type` stored on the notification row (kept close to the source event). */
  type: string;
  title: string;
  body: string;
  roleCodes: string[];
  priority?: NotificationPriority;
  severity?: NotifySeverity;
  actionLabel?: string;
  actionTarget?: string;
  /** When false, the event notifies in-app only (used for high-frequency scans). Defaults to true. */
  email?: boolean;
  /** Linked party to email/SMS (or in-app if they have an ERP login). */
  party?: 'customer' | 'employee' | 'supplier' | 'candidate';
  /** Optional copy sent to the linked customer (email/SMS), not ERP users. */
  customer?: { title: string; body: string };
  /** Optional copy sent to `party` (falls back to `customer`, then the internal title/body). */
  external?: { title: string; body: string };
}

/** Structural subset of the EventPayload emitted by `emitEvent`. */
export interface EventLike {
  eventType: string;
  entityType?: string | null;
  entityId?: number | null;
  entityCode?: string | null;
  payload?: Record<string, unknown>;
  severity?: string | null;
}

const PROD = ['production_manager', 'production_supervisor'];
const PLANNER = ['production_planner', 'production_scheduler'];
const PROC = ['procurement_manager', 'purchasing_officer'];
const FIN = ['finance_manager', 'chief_accountant'];
const CFO = ['cfo', 'finance_manager'];
const HR = ['hr_manager', 'hr_director', 'hr_officer'];
const PAYROLL = ['payroll_manager', 'payroll_officer', 'hr_manager'];
const TIME = ['time_attendance_officer', 'hr_officer', 'hr_manager'];
const RECRUIT = ['recruitment_officer', 'hr_manager'];
const RELATIONS = ['relations_officer', 'hr_manager', 'hr_director'];
const SALES = ['sales_manager', 'sales_director', 'sales_executive'];
const ASSET = ['asset_manager', 'asset_finance'];
const MAINT = ['maintenance_manager', 'maintenance_supervisor'];
const QC = ['quality_manager', 'quality_inspector'];
const WH = ['warehouse_manager', 'inventory_controller'];
const SEC = ['security_printing_manager', 'secure_job_approver'];
const SECADMIN = ['security_administrator'];
const LOG = ['logistics_manager', 'dispatch_manager'];
const HEALTH = ['healthcare_admin', 'doctor'];

/** Normalize an event type to an uppercase alphanumeric lookup key. */
export function normEventKey(eventType: string): string {
  return (eventType ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m: string, key: string) => vars[key] ?? `{{${key}}}`);
}

/** Build template variables from the event (entity code/id + payload fields). */
function fillVars(e: EventLike): Record<string, string> {
  const vars: Record<string, string> = {
    ENTITY_CODE: e.entityCode != null ? String(e.entityCode) : '',
    ENTITY_ID: e.entityId != null ? String(e.entityId) : '',
    entityId: e.entityId != null ? String(e.entityId) : '',
  };
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    const s = String(v);
    vars[k] = s;
    vars[k.replace(/[^A-Za-z0-9]/g, '').toUpperCase()] = s;
  }
  return vars;
}

/** Drop users who already hold a notification for the same type/entity (dedup). */
async function dedupUsers(
  client: pg.PoolClient,
  ctx: Ctx,
  userIds: number[],
  type: string,
  entityType: string | null | undefined,
  entityId: number | null | undefined
): Promise<number[]> {
  if (!entityType || userIds.length === 0) return userIds;
  const { rows } = await client.query(
    `SELECT DISTINCT user_id FROM notifications
      WHERE tenant_id = $1 AND type = $2 AND entity_type = $3
        AND entity_id IS NOT DISTINCT FROM $4 AND user_id = ANY($5::int[])`,
    [ctx.tenantId ?? 0, type, entityType, entityId ?? null, userIds]
  );
  const seen = new Set(rows.map((r) => Number(r.user_id)));
  return userIds.filter((u) => !seen.has(u));
}

let flushTimer: NodeJS.Timeout | null = null;

/**
 * Defer the external-channel dispatch a few seconds so the caller's
 * transaction has committed before the worker reads the new rows.
 */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    processNotificationDeliveries().catch((err: unknown) =>
      console.error('[eventNotifications]', err instanceof Error ? err.message : err)
    );
  }, 3000);
  if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
}

function humanize(eventType: string): string {
  const last = eventType.split('.').pop() ?? eventType;
  const words = last.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : eventType;
}

// ---------------------------------------------------------------------------
// Curated event → notification specs (keys are normalized event types).
// ---------------------------------------------------------------------------

export const EVENT_NOTIFY_MAP: Record<string, EventSpec> = {
  // ---------------- Production / Manufacturing ----------------
  PRODUCTIONPLANCREATED: {
    type: 'production.plan_created',
    title: 'Production plan created',
    body: 'Production plan {{ENTITY_CODE}} was created.',
    roleCodes: PROD,
    actionLabel: 'View plan',
    actionTarget: '/production/plan/{{entityId}}',
  },
  PRODUCTIONWORKORDERCREATED: {
    type: 'production.work_order_created',
    title: 'Production order created',
    body: 'Production order {{ENTITY_CODE}} has been created.',
    roleCodes: [...PROD, ...PLANNER],
    actionLabel: 'View order',
    actionTarget: '/production/orders/{{entityId}}',
  },
  PRODUCTIONWORKORDERRELEASED: {
    type: 'production.work_order_released',
    title: 'Production order released',
    body: 'Production order {{ENTITY_CODE}} has been released to the shop floor.',
    roleCodes: PROD,
    actionLabel: 'View order',
    actionTarget: '/production/orders/{{entityId}}',
  },
  PRODUCTIONSTARTED: {
    type: 'production.started',
    title: 'Production started',
    body: 'Production order {{ENTITY_CODE}} has started.',
    roleCodes: PROD,
    actionLabel: 'View order',
    actionTarget: '/production/orders/{{entityId}}',
  },
  PRODUCTIONCOMPLETED: {
    type: 'production.completed',
    title: 'Production completed',
    body: 'Production order {{ENTITY_CODE}} has been completed.',
    roleCodes: PROD,
    actionLabel: 'View order',
    actionTarget: '/production/orders/{{entityId}}',
  },
  PRODUCTIONWORKORDERCLOSED: {
    type: 'production.work_order_closed',
    title: 'Production order closed',
    body: 'Production order {{ENTITY_CODE}} has been closed.',
    roleCodes: PROD,
    actionLabel: 'View order',
    actionTarget: '/production/orders/{{entityId}}',
  },
  PRODUCTIONMATERIALRESERVED: {
    type: 'production.material.reserved',
    title: 'Material reserved',
    body: 'Materials were reserved for production order {{ENTITY_CODE}}.',
    roleCodes: [...WH, ...PROD],
  },
  PRODUCTIONMATERIALISSUED: {
    type: 'production.material.issued',
    title: 'Material issued to production',
    body: 'Materials were issued to production order {{ENTITY_CODE}}.',
    roleCodes: [...WH, ...PROD],
    actionLabel: 'View order',
    actionTarget: '/production/orders/{{entityId}}',
  },
  PRODUCTIONMATERIALAVAILABILITYOVERRIDDEN: {
    type: 'production.material.availability_overridden',
    title: 'Material availability overridden',
    body: 'Material availability was overridden for production order {{ENTITY_CODE}}.',
    roleCodes: PROD,
    priority: 'HIGH',
  },
  PRODUCTIONSHIFTHANDOVERCREATED: {
    type: 'production.shift_handover_created',
    title: 'Shift handover created',
    body: 'A shift handover for {{ENTITY_CODE}} is awaiting acknowledgement.',
    roleCodes: PROD,
    priority: 'HIGH',
    actionLabel: 'Review handover',
    actionTarget: '/production/handovers/{{entityId}}',
  },
  PRODUCTIONSHIFTHANDOVERACKNOWLEDGED: {
    type: 'production.shift_handover_acknowledged',
    title: 'Shift handover acknowledged',
    body: 'Shift handover {{ENTITY_CODE}} was acknowledged.',
    roleCodes: PROD,
  },
  PRODUCTIONQUALITYFAILED: {
    type: 'production.quality.failed',
    title: 'Quality check failed',
    body: 'Quality inspection failed for {{ENTITY_CODE}}.',
    roleCodes: [...QC, ...PROD],
    priority: 'HIGH',
    severity: 'WARN',
    actionLabel: 'Review quality',
    actionTarget: '/quality/non-conformance/{{entityId}}',
  },
  PRODUCTIONQUALITYDISPOSED: {
    type: 'production.quality.disposed',
    title: 'Quality disposition recorded',
    body: 'A quality disposition was recorded for {{ENTITY_CODE}}.',
    roleCodes: QC,
    severity: 'WARN',
  },
  PRODUCTIONSCRAPRECORDED: {
    type: 'production.scrap.recorded',
    title: 'Scrap recorded',
    body: 'Scrap was recorded against {{ENTITY_CODE}}.',
    roleCodes: PROD,
  },
  PRODUCTIONWASTERECORDED: {
    type: 'production.waste.recorded',
    title: 'Waste recorded',
    body: 'Waste was recorded against {{ENTITY_CODE}}.',
    roleCodes: PROD,
  },
  PRODUCTIONDOWNTIMERECORDED: {
    type: 'production.downtime.recorded',
    title: 'Downtime recorded',
    body: 'Downtime was recorded for {{ENTITY_CODE}}.',
    roleCodes: [...MAINT, ...PROD],
    severity: 'WARN',
    actionLabel: 'View downtime',
    actionTarget: '/shop-floor/downtime/{{entityId}}',
  },
  PRODUCTIONDOCUMENTSGENERATED: {
    type: 'production.documents.generated',
    title: 'Production documents generated',
    body: 'Documents were generated for {{ENTITY_CODE}}.',
    roleCodes: PROD,
  },
  PRODUCTIONSUBCONTRACTCREATED: {
    type: 'production.subcontract.created',
    title: 'Subcontract created',
    body: 'A subcontract was created for {{ENTITY_CODE}}.',
    roleCodes: PROD,
  },
  PRODUCTIONSUBCONTRACTUPDATED: {
    type: 'production.subcontract.updated',
    title: 'Subcontract updated',
    body: 'Subcontract for {{ENTITY_CODE}} was updated.',
    roleCodes: PROD,
  },
  PRODUCTIONREWORKCREATED: {
    type: 'production.rework.created',
    title: 'Rework created',
    body: 'A rework record was created for {{ENTITY_CODE}}.',
    roleCodes: QC,
    priority: 'HIGH',
  },
  PRODUCTIONREWORKUPDATED: {
    type: 'production.rework.updated',
    title: 'Rework updated',
    body: 'Rework for {{ENTITY_CODE}} was updated.',
    roleCodes: QC,
  },
  PRODUCTIONLABOURRECORDED: {
    type: 'production.labour_recorded',
    title: 'Labour recorded',
    body: 'Labour was recorded against {{ENTITY_CODE}}.',
    roleCodes: PROD,
  },
  PRODUCTIONBATCHCREATED: {
    type: 'production.batch.created',
    title: 'Production batch created',
    body: 'Production batch {{ENTITY_CODE}} was created.',
    roleCodes: [...WH, ...PROD],
    actionLabel: 'View batch',
    actionTarget: '/inventory/lots/{{entityId}}',
  },
  PRODUCTIONSTANDARDUPSERTED: {
    type: 'PRODUCTION_STANDARD_UPSERTED',
    title: 'Production standard updated',
    body: 'A production standard was created or updated.',
    roleCodes: PROD,
  },
  MRPCOMPLETED: {
    type: 'mrp.completed',
    title: 'MRP run completed',
    body: 'Material requirements planning completed for {{ENTITY_CODE}}.',
    roleCodes: [...PLANNER, ...PROC],
    actionLabel: 'Review MRP',
    actionTarget: '/planning/mrp/{{entityId}}',
  },

  // ---------------- Procurement ----------------
  PROCUREMENTREQUISITIONCREATED: {
    type: 'procurement.requisition_created',
    title: 'Purchase requisition created',
    body: 'Purchase requisition {{ENTITY_CODE}} was created.',
    roleCodes: PROC,
  },
  PROCUREMENTREQUISITIONSUBMITTED: {
    type: 'procurement.requisition_submitted',
    title: 'Purchase requisition submitted',
    body: 'Purchase requisition {{ENTITY_CODE}} was submitted for approval.',
    roleCodes: PROC,
    priority: 'HIGH',
    actionLabel: 'Review requisition',
    actionTarget: '/procurement/requisitions/{{entityId}}',
  },
  PROCUREMENTREQUISITIONSTATUSCHANGED: {
    type: 'procurement.requisition_status_changed',
    title: 'Requisition status changed',
    body: 'Purchase requisition {{ENTITY_CODE}} changed status.',
    roleCodes: PROC,
    priority: 'HIGH',
  },
  PROCUREMENTREQUISITIONUPDATED: {
    type: 'procurement.requisition_updated',
    title: 'Requisition updated',
    body: 'Purchase requisition {{ENTITY_CODE}} was updated.',
    roleCodes: PROC,
  },
  PROCUREMENTREQUISITIONCANCELLED: {
    type: 'procurement.requisition_cancelled',
    title: 'Requisition cancelled',
    body: 'Purchase requisition {{ENTITY_CODE}} was cancelled.',
    roleCodes: PROC,
  },
  PROCUREMENTREQUISITIONREOPENED: {
    type: 'procurement.requisition_reopened',
    title: 'Requisition reopened',
    body: 'Purchase requisition {{ENTITY_CODE}} was reopened.',
    roleCodes: PROC,
  },
  PROCUREMENTPOCREATED: {
    type: 'procurement.po_created',
    title: 'Purchase order created',
    body: 'Purchase order {{ENTITY_CODE}} was created.',
    roleCodes: PROC,
    priority: 'HIGH',
    actionLabel: 'Review purchase order',
    actionTarget: '/procurement/purchase-orders/{{entityId}}',
    party: 'supplier',
    external: {
      title: 'Purchase order {{ENTITY_CODE}}',
      body: 'Dear {{PARTY_NAME}}, Hope Design has created purchase order {{ENTITY_CODE}}.',
    },
  },
  PROCUREMENTPOAPPROVED: {
    type: 'procurement.po_approved',
    title: 'Purchase order approved',
    body: 'Purchase order {{ENTITY_CODE}} was approved.',
    roleCodes: PROC,
    priority: 'HIGH',
    actionLabel: 'View purchase order',
    actionTarget: '/procurement/purchase-orders/{{entityId}}',
    party: 'supplier',
    external: {
      title: 'Purchase order {{ENTITY_CODE}} approved',
      body: 'Dear {{PARTY_NAME}}, purchase order {{ENTITY_CODE}} from Hope Design has been approved.',
    },
  },
  PROCUREMENTPOAMENDED: {
    type: 'procurement.po_amended',
    title: 'Purchase order amended',
    body: 'Purchase order {{ENTITY_CODE}} was amended.',
    roleCodes: PROC,
    priority: 'HIGH',
  },
  PROCUREMENTGOODSRECEIVED: {
    type: 'procurement.goods_received',
    title: 'Goods received',
    body: 'Goods were received against {{ENTITY_CODE}}.',
    roleCodes: [...WH, ...PROC],
    actionLabel: 'View receipt',
    actionTarget: '/inventory/receipts/{{entityId}}',
    party: 'supplier',
    external: {
      title: 'Goods received — {{ENTITY_CODE}}',
      body: 'Dear {{PARTY_NAME}}, Hope Design has received goods against {{ENTITY_CODE}}.',
    },
  },
  PROCUREMENTQUOTATIONRECEIVED: {
    type: 'procurement.quotation_received',
    title: 'Quotation received',
    body: 'A quotation was received for {{ENTITY_CODE}}.',
    roleCodes: PROC,
  },
  PROCUREMENTRFQISSUED: {
    type: 'procurement.rfq_issued',
    title: 'RFQ issued',
    body: 'Request for quotation {{ENTITY_CODE}} was issued.',
    roleCodes: PROC,
    party: 'supplier',
    external: {
      title: 'Request for quotation {{ENTITY_CODE}}',
      body: 'Dear {{PARTY_NAME}}, Hope Design invites you to quote on RFQ {{ENTITY_CODE}}.',
    },
  },
  PROCUREMENTRFQAWARDED: {
    type: 'procurement.rfq_awarded',
    title: 'RFQ awarded',
    body: 'Request for quotation {{ENTITY_CODE}} was awarded.',
    roleCodes: PROC,
  },
  PROCUREMENTSUPPLIERCREATED: {
    type: 'procurement.supplier_created',
    title: 'Supplier created',
    body: 'Supplier {{ENTITY_CODE}} was added.',
    roleCodes: PROC,
  },
  PROCUREMENTRETURNCREATED: {
    type: 'procurement.return_created',
    title: 'Supplier return created',
    body: 'A return was created against {{ENTITY_CODE}}.',
    roleCodes: PROC,
  },
  PROCUREMENTPAYMENTCREATED: {
    type: 'procurement.payment_created',
    title: 'Supplier payment created',
    body: 'A supplier payment was created for {{ENTITY_CODE}}.',
    roleCodes: FIN,
    party: 'supplier',
    external: {
      title: 'Payment {{ENTITY_CODE}}',
      body: 'Dear {{PARTY_NAME}}, Hope Design has recorded payment {{ENTITY_CODE}}.',
    },
  },
  PROCUREMENTSUPPLIERINVOICECREATED: {
    type: 'procurement.supplier_invoice_created',
    title: 'Supplier invoice created',
    body: 'Supplier invoice {{ENTITY_CODE}} was created.',
    roleCodes: FIN,
    actionLabel: 'Review invoice',
    actionTarget: '/procurement/invoices/{{entityId}}',
  },

  // ---------------- Sales ----------------
  SALESORDERCREATED: {
    type: 'sales.order_created',
    title: 'Sales order created',
    body: 'Sales order {{ENTITY_CODE}} was created.',
    roleCodes: SALES,
    actionLabel: 'View order',
    actionTarget: '/sales/orders/{{entityId}}',
    customer: {
      title: 'Your order {{ENTITY_CODE}}',
      body: 'Dear {{CUSTOMER_NAME}}, Hope Design has recorded sales order {{ENTITY_CODE}}. We will update you as it is allocated and dispatched.',
    },
  },
  SALESORDERALLOCATED: {
    type: 'sales.order_allocated',
    title: 'Sales order allocated',
    body: 'Stock was allocated to sales order {{ENTITY_CODE}}.',
    roleCodes: [...SALES, ...WH],
  },
  SALESQUOTATIONCREATED: {
    type: 'sales.quotation_created',
    title: 'Quotation created',
    body: 'Quotation {{ENTITY_CODE}} was created.',
    roleCodes: SALES,
  },
  SALESQUOTATIONSENT: {
    type: 'sales.quotation_sent',
    title: 'Quotation sent to customer',
    body: 'Quotation {{ENTITY_CODE}} was sent to the customer.',
    roleCodes: SALES,
  },
  SALESQUOTATIONCONVERTED: {
    type: 'sales.quotation_converted',
    title: 'Quotation converted',
    body: 'Quotation {{ENTITY_CODE}} was converted to a sales order.',
    roleCodes: SALES,
    customer: {
      title: 'Quotation {{ENTITY_CODE}} accepted',
      body: 'Dear {{CUSTOMER_NAME}}, thank you. Quotation {{ENTITY_CODE}} has been converted into a sales order. We will confirm fulfilment shortly.',
    },
  },
  SALESINVOICECREATED: {
    type: 'sales.invoice_created',
    title: 'Sales invoice created',
    body: 'Sales invoice {{ENTITY_CODE}} was created.',
    roleCodes: [...SALES, ...FIN],
    actionLabel: 'View invoice',
    actionTarget: '/sales/invoices/{{entityId}}',
    customer: {
      title: 'Invoice {{ENTITY_CODE}}',
      body: 'Dear {{CUSTOMER_NAME}}, Hope Design has issued invoice {{ENTITY_CODE}}. Please arrange payment per the agreed terms.',
    },
  },
  SALESRECEIPTPOSTED: {
    type: 'sales.receipt_posted',
    title: 'Payment received',
    body: 'A receipt was posted against {{ENTITY_CODE}}.',
    roleCodes: FIN,
    customer: {
      title: 'Payment received — {{ENTITY_CODE}}',
      body: 'Dear {{CUSTOMER_NAME}}, we have received your payment ({{ENTITY_CODE}}). Thank you.',
    },
  },
  SALESDELIVERYDISPATCHED: {
    type: 'sales.delivery_dispatched',
    title: 'Delivery dispatched',
    body: 'Delivery {{ENTITY_CODE}} was dispatched.',
    roleCodes: [...SALES, ...LOG],
    actionLabel: 'Track delivery',
    actionTarget: '/logistics/deliveries/{{entityId}}',
    customer: {
      title: 'Your delivery {{ENTITY_CODE}} is on the way',
      body: 'Dear {{CUSTOMER_NAME}}, Hope Design has dispatched delivery {{ENTITY_CODE}}.',
    },
  },
  SALESDELIVERYDELIVERED: {
    type: 'sales.delivery_delivered',
    title: 'Delivery completed',
    body: 'Delivery {{ENTITY_CODE}} was marked delivered.',
    roleCodes: SALES,
    customer: {
      title: 'Delivered — {{ENTITY_CODE}}',
      body: 'Dear {{CUSTOMER_NAME}}, Hope Design has completed delivery {{ENTITY_CODE}}. Thank you.',
    },
  },
  SALESRETURNCREATED: {
    type: 'sales.return_created',
    title: 'Sales return created',
    body: 'Sales return {{ENTITY_CODE}} was created.',
    roleCodes: SALES,
    priority: 'HIGH',
  },
  SALESRETURNCOMPLETED: {
    type: 'sales.return_completed',
    title: 'Sales return completed',
    body: 'Sales return {{ENTITY_CODE}} was completed.',
    roleCodes: SALES,
  },
  SALESCREDITNOTECREATED: {
    type: 'sales.credit_note_created',
    title: 'Credit note created',
    body: 'Credit note {{ENTITY_CODE}} was created.',
    roleCodes: FIN,
  },
  SALESDEBITNOTECREATED: {
    type: 'sales.debit_note_created',
    title: 'Debit note created',
    body: 'Debit note {{ENTITY_CODE}} was created.',
    roleCodes: FIN,
  },

  // ---------------- Finance ----------------
  FINANCEINVOICEPOSTED: {
    type: 'finance.invoice_posted',
    title: 'Invoice posted',
    body: 'Invoice {{ENTITY_CODE}} was posted to the ledger.',
    roleCodes: FIN,
  },
  FINANCERECEIPTPOSTED: {
    type: 'finance.receipt_posted',
    title: 'Receipt posted',
    body: 'Receipt {{ENTITY_CODE}} was posted to the ledger.',
    roleCodes: FIN,
  },
  FINANCESUPPLIERINVOICEPOSTED: {
    type: 'finance.supplier_invoice_posted',
    title: 'Supplier invoice posted',
    body: 'Supplier invoice {{ENTITY_CODE}} was posted.',
    roleCodes: FIN,
  },
  FINANCESUPPLIERPAYMENTPOSTED: {
    type: 'finance.supplier_payment_posted',
    title: 'Supplier payment posted',
    body: 'Supplier payment {{ENTITY_CODE}} was posted.',
    roleCodes: FIN,
  },
  FINANCEJOURNALCREATED: {
    type: 'finance.journal.created',
    title: 'Journal created',
    body: 'Journal entry {{ENTITY_CODE}} was created.',
    roleCodes: FIN,
  },
  FINANCEJOURNALPOSTED: {
    type: 'finance.journal.posted',
    title: 'Journal posted',
    body: 'Journal entry {{ENTITY_CODE}} was posted.',
    roleCodes: FIN,
  },
  FINANCEJOURNALREVERSED: {
    type: 'finance.journal.reversed',
    title: 'Journal reversed',
    body: 'Journal entry {{ENTITY_CODE}} was reversed.',
    roleCodes: FIN,
    priority: 'HIGH',
    severity: 'WARN',
  },
  FINANCEPAYROLLPOSTED: {
    type: 'finance.payroll_posted',
    title: 'Payroll posted',
    body: 'Payroll {{ENTITY_CODE}} was posted to the ledger.',
    roleCodes: [...FIN, ...HR],
  },
  FINANCEPERIODCLOSED: {
    type: 'finance.period.closed',
    title: 'Period closed',
    body: 'Accounting period {{ENTITY_CODE}} was closed.',
    roleCodes: FIN,
  },
  FINANCEINTERCOMPANYPOSTED: {
    type: 'finance.intercompany.posted',
    title: 'Intercompany entry posted',
    body: 'Intercompany entry {{ENTITY_CODE}} was posted.',
    roleCodes: FIN,
  },
  FINANCECONSOLIDATIONCOMPLETED: {
    type: 'finance.consolidation.completed',
    title: 'Consolidation completed',
    body: 'Financial consolidation {{ENTITY_CODE}} completed.',
    roleCodes: CFO,
  },
  FINANCEPRODUCTIONCOSTCALCULATED: {
    type: 'finance.production_cost.calculated',
    title: 'Production cost calculated',
    body: 'Production cost was calculated for {{ENTITY_CODE}}.',
    roleCodes: [...FIN, ...PROD],
  },

  // ---------------- HR ----------------
  HREMPLOYEECREATED: {
    type: 'hr.employee_created',
    title: 'Employee record created',
    body: 'Employee {{ENTITY_CODE}} was added to the system.',
    roleCodes: HR,
  },
  HREMPLOYEEHIRED: {
    type: 'hr.employee_hired',
    title: 'Employee hired',
    body: 'Employee {{ENTITY_CODE}} was hired.',
    roleCodes: HR,
  },
  HREMPLOYEEEXITED: {
    type: 'hr.employee_exited',
    title: 'Employee exited',
    body: 'Employee {{ENTITY_CODE}} exited the company.',
    roleCodes: HR,
  },
  HRCONTRACTCREATED: {
    type: 'hr.contract_created',
    title: 'Contract created',
    body: 'Contract {{ENTITY_CODE}} was created.',
    roleCodes: HR,
    actionLabel: 'View contract',
    actionTarget: '/hr/contracts/{{entityId}}',
  },
  HRCONTRACTEXECUTED: {
    type: 'hr.contract_executed',
    title: 'Contract executed',
    body: 'Contract {{ENTITY_CODE}} was executed.',
    roleCodes: HR,
  },
  HRCONTRACTRENEWALCREATED: {
    type: 'hr.contract_renewal_created',
    title: 'Contract renewal created',
    body: 'A renewal was created for contract {{ENTITY_CODE}}.',
    roleCodes: HR,
  },
  HRCONTRACTRENEWALAPPLIED: {
    type: 'hr.contract_renewal_applied',
    title: 'Contract renewal applied',
    body: 'Renewal was applied to contract {{ENTITY_CODE}}.',
    roleCodes: HR,
  },
  HRCONTRACTVARIATIONCREATED: {
    type: 'hr.contract_variation_created',
    title: 'Contract variation created',
    body: 'A variation was created for contract {{ENTITY_CODE}}.',
    roleCodes: HR,
  },
  HRCONTRACTVARIATIONAPPLIED: {
    type: 'hr.contract_variation_applied',
    title: 'Contract variation applied',
    body: 'A variation was applied to contract {{ENTITY_CODE}}.',
    roleCodes: HR,
  },
  HRCONTRACTSENTFORSIGNATURE: {
    type: 'hr.contract_sent_for_signature',
    title: 'Contract sent for signature',
    body: 'Contract {{ENTITY_CODE}} was sent for signature.',
    roleCodes: HR,
    priority: 'HIGH',
  },
  HRADVANCEREQUESTED: {
    type: 'hr.advance.requested',
    title: 'Salary advance requested',
    body: 'A salary advance was requested for {{ENTITY_CODE}}.',
    roleCodes: [...FIN, ...HR],
    priority: 'HIGH',
  },
  HRADVANCEAPPROVED: {
    type: 'hr.advance.approved',
    title: 'Salary advance approved',
    body: 'Salary advance for {{ENTITY_CODE}} was approved.',
    roleCodes: HR,
  },
  HRLOANCREATED: {
    type: 'hr.loan.created',
    title: 'Employee loan created',
    body: 'Employee loan {{ENTITY_CODE}} was created.',
    roleCodes: FIN,
  },
  HRLOANAPPROVED: {
    type: 'hr.loan.approved',
    title: 'Employee loan approved',
    body: 'Employee loan {{ENTITY_CODE}} was approved.',
    roleCodes: HR,
  },
  HRFINALSETTLEMENTPREPARED: {
    type: 'hr.final_settlement.prepared',
    title: 'Final settlement prepared',
    body: 'Final settlement {{ENTITY_CODE}} was prepared.',
    roleCodes: HR,
  },
  HRFINALSETTLEMENTSUBMITTED: {
    type: 'hr.final_settlement.submitted',
    title: 'Final settlement submitted',
    body: 'Final settlement {{ENTITY_CODE}} was submitted for approval.',
    roleCodes: [...HR, ...FIN],
    priority: 'HIGH',
  },
  HRFINALSETTLEMENTAPPROVED: {
    type: 'hr.final_settlement.approved',
    title: 'Final settlement approved',
    body: 'Final settlement {{ENTITY_CODE}} was approved.',
    roleCodes: [...HR, ...FIN],
  },
  HRFINALSETTLEMENTPAID: {
    type: 'hr.final_settlement.paid',
    title: 'Final settlement paid',
    body: 'Final settlement {{ENTITY_CODE}} was paid.',
    roleCodes: [...HR, ...FIN],
  },
  HRFINALSETTLEMENTREJECTED: {
    type: 'hr.final_settlement.rejected',
    title: 'Final settlement rejected',
    body: 'Final settlement {{ENTITY_CODE}} was rejected.',
    roleCodes: HR,
    priority: 'HIGH',
    severity: 'WARN',
  },
  HRONBOARDINGCOMPLETED: {
    type: 'hr.onboarding_completed',
    title: 'Onboarding completed',
    body: 'Onboarding for {{ENTITY_CODE}} was completed.',
    roleCodes: HR,
  },
  HROFFBOARDINGCREATED: {
    type: 'hr.offboarding_created',
    title: 'Offboarding created',
    body: 'Offboarding for {{ENTITY_CODE}} was created.',
    roleCodes: HR,
  },
  HRVACANCYPUBLISHED: {
    type: 'hr.vacancy_published',
    title: 'Vacancy published',
    body: 'Vacancy {{ENTITY_CODE}} was published.',
    roleCodes: RECRUIT,
  },
  HRAPPLICATIONSUBMITTED: {
    type: 'hr.application_submitted',
    title: 'Job application submitted',
    body: 'An application was submitted for {{ENTITY_CODE}}.',
    roleCodes: RECRUIT,
    party: 'candidate',
    external: {
      title: 'Application received',
      body: 'Dear {{PARTY_NAME}}, Hope Design has received your application {{ENTITY_CODE}}.',
    },
  },
  HRWORKFORCEPLANCREATED: {
    type: 'hr.workforce_plan_created',
    title: 'Workforce plan created',
    body: 'Workforce plan {{ENTITY_CODE}} was created.',
    roleCodes: HR,
  },
  HRPAYROLLPAYMENTBATCHCREATED: {
    type: 'hr.payroll.payment_batch_created',
    title: 'Payroll payment batch created',
    body: 'Payroll payment batch {{ENTITY_CODE}} was created.',
    roleCodes: [...FIN, ...PAYROLL],
  },
  HRPAYROLLPAYMENTCONFIRMED: {
    type: 'hr.payroll.payment_confirmed',
    title: 'Payroll payment confirmed',
    body: 'Payroll payment batch {{ENTITY_CODE}} was confirmed.',
    roleCodes: [...FIN, ...PAYROLL],
  },
  HRPAYROLLSUBMITTED: {
    type: 'hr.payroll.submitted',
    title: 'Payroll submitted',
    body: 'Payroll {{ENTITY_CODE}} was submitted for approval.',
    roleCodes: [...PAYROLL, ...FIN],
    priority: 'HIGH',
    actionLabel: 'Review payroll',
    actionTarget: '/hr/payroll/{{entityId}}',
  },
  HRPAYROLLPOSTED: {
    type: 'hr.payroll.posted',
    title: 'Payroll posted',
    body: 'Payroll {{ENTITY_CODE}} was posted to the ledger.',
    roleCodes: [...PAYROLL, ...FIN],
  },
  HRLEAVEREQUESTED: {
    type: 'hr.leave.requested',
    title: 'Leave requested',
    body: 'Leave was requested for {{ENTITY_CODE}}.',
    roleCodes: [...HR, ...TIME],
    priority: 'HIGH',
    actionLabel: 'Review leave',
    actionTarget: '/hr/leave',
    party: 'employee',
    external: {
      title: 'Leave request received',
      body: 'Dear {{PARTY_NAME}}, we have received your leave request {{ENTITY_CODE}}. HR will review it.',
    },
  },
  HRLEAVEAPPROVED: {
    type: 'hr.leave.approved',
    title: 'Leave approved',
    body: 'Leave {{ENTITY_CODE}} was approved.',
    roleCodes: [...HR, ...TIME],
    party: 'employee',
    external: {
      title: 'Your leave was approved',
      body: 'Dear {{PARTY_NAME}}, your leave request {{ENTITY_CODE}} has been approved.',
    },
  },
  HRLEAVEREJECTED: {
    type: 'hr.leave.rejected',
    title: 'Leave rejected',
    body: 'Leave {{ENTITY_CODE}} was rejected.',
    roleCodes: HR,
    severity: 'WARN',
    party: 'employee',
    external: {
      title: 'Your leave was not approved',
      body: 'Dear {{PARTY_NAME}}, your leave request {{ENTITY_CODE}} was not approved. Please contact HR.',
    },
  },
  HREMPLOYEETERMINATED: {
    type: 'hr.employee_terminated',
    title: 'Employee terminated',
    body: 'Employee {{ENTITY_CODE}} was terminated.',
    roleCodes: [...HR, ...PAYROLL],
    priority: 'HIGH',
    party: 'employee',
  },
  HRTIMESHEETSUBMITTED: {
    type: 'hr.timesheet.submitted',
    title: 'Timesheet submitted',
    body: 'A timesheet was submitted for {{ENTITY_CODE}}.',
    roleCodes: TIME,
    party: 'employee',
  },
  HRTIMESHEETAPPROVED: {
    type: 'hr.timesheet.approved',
    title: 'Timesheet approved',
    body: 'Timesheet {{ENTITY_CODE}} was approved.',
    roleCodes: TIME,
    party: 'employee',
    external: {
      title: 'Your timesheet was approved',
      body: 'Dear {{PARTY_NAME}}, your timesheet {{ENTITY_CODE}} has been approved.',
    },
  },
  HRGRIEVANCEOPENED: {
    type: 'hr.grievance.opened',
    title: 'Grievance opened',
    body: 'A grievance was opened for {{ENTITY_CODE}}.',
    roleCodes: RELATIONS,
    priority: 'HIGH',
    party: 'employee',
  },
  HRGRIEVANCERESOLVED: {
    type: 'hr.grievance.resolved',
    title: 'Grievance resolved',
    body: 'Grievance {{ENTITY_CODE}} was resolved.',
    roleCodes: RELATIONS,
    party: 'employee',
    external: {
      title: 'Your grievance was resolved',
      body: 'Dear {{PARTY_NAME}}, Hope Design has resolved grievance {{ENTITY_CODE}}.',
    },
  },
  HRWARNINGISSUED: {
    type: 'hr.warning.issued',
    title: 'Warning issued',
    body: 'A warning was issued to {{ENTITY_CODE}}.',
    roleCodes: RELATIONS,
    priority: 'HIGH',
    party: 'employee',
    external: {
      title: 'Workplace warning issued',
      body: 'Dear {{PARTY_NAME}}, a warning has been recorded on your file ({{ENTITY_CODE}}). Please speak with HR if you have questions.',
    },
  },
  HRTRAININGREQUESTED: {
    type: 'hr.training.requested',
    title: 'Training requested',
    body: 'A training request was submitted for {{ENTITY_CODE}}.',
    roleCodes: [...HR, 'training_officer'],
    party: 'employee',
  },
  HRTRAININGAPPROVED: {
    type: 'hr.training.approved',
    title: 'Training approved',
    body: 'Training request {{ENTITY_CODE}} was approved.',
    roleCodes: [...HR, 'training_officer'],
    party: 'employee',
    external: {
      title: 'Your training was approved',
      body: 'Dear {{PARTY_NAME}}, your training request {{ENTITY_CODE}} has been approved.',
    },
  },
  HROFFERSENT: {
    type: 'hr.offer_sent',
    title: 'Job offer sent',
    body: 'Offer {{ENTITY_CODE}} was sent to the candidate.',
    roleCodes: RECRUIT,
    priority: 'HIGH',
    party: 'candidate',
    external: {
      title: 'Job offer from Hope Design',
      body: 'Dear {{PARTY_NAME}}, Hope Design has sent you offer {{ENTITY_CODE}}. Please respond by the stated expiry.',
    },
  },
  HRREQUISITIONCREATED: {
    type: 'hr.requisition_created',
    title: 'HR requisition created',
    body: 'HR requisition {{ENTITY_CODE}} was created.',
    roleCodes: [...HR, ...PROC],
  },
  HREMPLOYEECARDGENERATED: {
    type: 'hr.employee_card_generated',
    title: 'Employee card generated',
    body: 'An employee ID card was generated for {{ENTITY_CODE}}.',
    roleCodes: HR,
  },
  HREMPLOYEECARDISSUED: {
    type: 'hr.employee_card_issued',
    title: 'Employee card issued',
    body: 'An employee ID card was issued to {{ENTITY_CODE}}.',
    roleCodes: HR,
  },
  HREMPLOYEECARDREPLACED: {
    type: 'hr.employee_card_replaced',
    title: 'Employee card replaced',
    body: 'The employee ID card for {{ENTITY_CODE}} was replaced.',
    roleCodes: HR,
  },
  HREMPLOYEEIDGENERATED: {
    type: 'hr.employee_id_generated',
    title: 'Employee ID generated',
    body: 'An employee ID was generated for {{ENTITY_CODE}}.',
    roleCodes: HR,
  },
  HREMPLOYEEQRGENERATED: {
    type: 'hr.employee_qr_generated',
    title: 'Employee QR generated',
    body: 'A QR code was generated for employee {{ENTITY_CODE}}.',
    roleCodes: [...HR, ...SECADMIN],
  },
  HREMPLOYEEQRSCANNED: {
    type: 'hr.employee_qr_scanned',
    title: 'Employee QR scanned',
    body: 'The QR code for employee {{ENTITY_CODE}} was scanned.',
    roleCodes: SECADMIN,
    email: false,
  },
  HRCERTIFICATECREATED: {
    type: 'hr.certificate_created',
    title: 'Certificate created',
    body: 'Certificate {{ENTITY_CODE}} was created.',
    roleCodes: HR,
  },
  HRCERTIFICATEISSUED: {
    type: 'hr.certificate_issued',
    title: 'Certificate issued',
    body: 'Certificate {{ENTITY_CODE}} was issued.',
    roleCodes: HR,
  },
  HREMPLOYEEASSIGNMENTCREATED: {
    type: 'hr.employee_assignment_created',
    title: 'Employee assignment created',
    body: 'An assignment was created for employee {{ENTITY_CODE}}.',
    roleCodes: [...HR, ...ASSET],
  },

  // ---------------- Assets ----------------
  ASSETREGISTERED: {
    type: 'asset.registered',
    title: 'Asset registered',
    body: 'Asset {{ENTITY_CODE}} was registered.',
    roleCodes: ASSET,
    actionLabel: 'View asset',
    actionTarget: '/assets/{{entityId}}',
  },
  ASSETSREGISTERED: {
    type: 'asset.registered',
    title: 'Asset registered',
    body: 'Asset {{ENTITY_CODE}} was registered.',
    roleCodes: ASSET,
    actionLabel: 'View asset',
    actionTarget: '/assets/{{entityId}}',
  },
  ASSETSCANNED: {
    type: 'asset.scanned',
    title: 'Asset scanned',
    body: 'Asset {{ENTITY_CODE}} was scanned.',
    roleCodes: ASSET,
    email: false,
  },
  ASSETSASSIGNED: {
    type: 'assets.assigned',
    title: 'Asset assigned',
    body: 'Asset {{ENTITY_CODE}} was assigned to a custodian.',
    roleCodes: ASSET,
    priority: 'HIGH',
    actionLabel: 'View assignment',
    actionTarget: '/assets/assignments/{{entityId}}',
  },
  ASSETSRETURNED: {
    type: 'assets.returned',
    title: 'Asset returned',
    body: 'Asset {{ENTITY_CODE}} was returned from custody.',
    roleCodes: ASSET,
  },
  ASSETSTRANSFERREQUESTED: {
    type: 'assets.transfer_requested',
    title: 'Asset transfer requested',
    body: 'A transfer was requested for asset {{ENTITY_CODE}}.',
    roleCodes: ASSET,
    priority: 'HIGH',
    actionLabel: 'Review transfer',
    actionTarget: '/assets/transfers/{{entityId}}',
  },
  ASSETSTRANSFERAPPROVED: {
    type: 'assets.transfer_approved',
    title: 'Asset transfer approved',
    body: 'Transfer of asset {{ENTITY_CODE}} was approved.',
    roleCodes: ASSET,
  },
  ASSETSTRANSFERCOMPLETED: {
    type: 'assets.transfer_completed',
    title: 'Asset transfer completed',
    body: 'Transfer of asset {{ENTITY_CODE}} was completed.',
    roleCodes: ASSET,
  },
  ASSETSMAINTENANCECREATED: {
    type: 'assets.maintenance_created',
    title: 'Maintenance work order created',
    body: 'Maintenance work order {{ENTITY_CODE}} was created.',
    roleCodes: MAINT,
    actionLabel: 'View work order',
    actionTarget: '/maintenance/work-orders/{{entityId}}',
  },
  ASSETSMAINTENANCESUBMITTED: {
    type: 'assets.maintenance_submitted',
    title: 'Maintenance submitted',
    body: 'Maintenance work order {{ENTITY_CODE}} was submitted.',
    roleCodes: MAINT,
  },
  ASSETSMAINTENANCESTARTED: {
    type: 'assets.maintenance_started',
    title: 'Maintenance started',
    body: 'Maintenance on {{ENTITY_CODE}} started.',
    roleCodes: MAINT,
  },
  ASSETSMAINTENANCECOMPLETED: {
    type: 'assets.maintenance_completed',
    title: 'Maintenance completed',
    body: 'Maintenance on {{ENTITY_CODE}} was completed.',
    roleCodes: MAINT,
  },
  ASSETSMAINTENANCECANCELLED: {
    type: 'assets.maintenance_cancelled',
    title: 'Maintenance cancelled',
    body: 'Maintenance work order {{ENTITY_CODE}} was cancelled.',
    roleCodes: MAINT,
  },
  ASSETSREPORTEDMISSING: {
    type: 'assets.reported_missing',
    title: 'Asset reported missing',
    body: 'Asset {{ENTITY_CODE}} was reported missing.',
    roleCodes: [...ASSET, ...SECADMIN],
    priority: 'URGENT',
    severity: 'ERROR',
    actionLabel: 'Investigate',
    actionTarget: '/assets/{{entityId}}',
  },
  ASSETSDISPOSALCREATED: {
    type: 'assets.disposal_created',
    title: 'Disposal requested',
    body: 'A disposal was requested for asset {{ENTITY_CODE}}.',
    roleCodes: [...ASSET, ...FIN],
  },
  ASSETSDISPOSALCOMPLETED: {
    type: 'assets.disposal_completed',
    title: 'Asset disposed',
    body: 'Asset {{ENTITY_CODE}} was disposed.',
    roleCodes: [...ASSET, ...FIN],
  },
  ASSETSDEPRECIATIONPOSTED: {
    type: 'assets.depreciation_posted',
    title: 'Depreciation posted',
    body: 'Depreciation was posted for {{ENTITY_CODE}}.',
    roleCodes: FIN,
  },
  ASSETSIMPAIRMENTPOSTED: {
    type: 'assets.impairment_posted',
    title: 'Impairment posted',
    body: 'An impairment was posted for {{ENTITY_CODE}}.',
    roleCodes: FIN,
  },
  ASSETSVERIFIED: {
    type: 'assets.verified',
    title: 'Asset verified',
    body: 'Asset {{ENTITY_CODE}} was verified.',
    roleCodes: ASSET,
  },
  ASSETSAUDITCREATED: {
    type: 'assets.audit_created',
    title: 'Asset audit created',
    body: 'Asset audit {{ENTITY_CODE}} was created.',
    roleCodes: ASSET,
  },
  ASSETSAUDITSTARTED: {
    type: 'assets.audit_started',
    title: 'Asset audit started',
    body: 'Asset audit {{ENTITY_CODE}} started.',
    roleCodes: ASSET,
  },
  ASSETSAUDITSUBMITTED: {
    type: 'assets.audit_submitted',
    title: 'Asset audit submitted',
    body: 'Asset audit {{ENTITY_CODE}} was submitted.',
    roleCodes: ASSET,
  },
  ASSETSAUDITAPPROVED: {
    type: 'assets.audit_approved',
    title: 'Asset audit approved',
    body: 'Asset audit {{ENTITY_CODE}} was approved.',
    roleCodes: ASSET,
  },
  ASSETSAUDITCLOSED: {
    type: 'assets.audit_closed',
    title: 'Asset audit closed',
    body: 'Asset audit {{ENTITY_CODE}} was closed.',
    roleCodes: ASSET,
  },
  ASSETSAUDITCANCELLED: {
    type: 'assets.audit_cancelled',
    title: 'Asset audit cancelled',
    body: 'Asset audit {{ENTITY_CODE}} was cancelled.',
    roleCodes: ASSET,
  },
  ASSETSAUDITSCAN: {
    type: 'assets.audit_scan',
    title: 'Asset audit scan',
    body: 'A scan was recorded against asset audit {{ENTITY_CODE}}.',
    roleCodes: ASSET,
    email: false,
  },

  // ---------------- Quality ----------------
  QUALITYINSPECTIONCOMPLETED: {
    type: 'quality.inspection_completed',
    title: 'Quality inspection completed',
    body: 'Quality inspection for {{ENTITY_CODE}} was completed.',
    roleCodes: [...QC, ...PROD],
    actionLabel: 'View inspection',
    actionTarget: '/quality/inspections/{{entityId}}',
  },
  QUALITYINSPECTIONCREATED: {
    type: 'QUALITY_INSPECTION_CREATED',
    title: 'Quality inspection created',
    body: 'Quality inspection {{ENTITY_CODE}} was created.',
    roleCodes: QC,
  },
  QUALITYINSPECTIONRESULT: {
    type: 'QUALITY_INSPECTION_RESULT',
    title: 'Quality inspection result',
    body: 'A result was recorded for inspection {{ENTITY_CODE}}.',
    roleCodes: QC,
  },

  // ---------------- Security Printing ----------------
  SECURITYPRINTINGJOBCREATED: {
    type: 'security_printing.job_created',
    title: 'Security printing job created',
    body: 'Security printing job {{ENTITY_CODE}} was created.',
    roleCodes: SEC,
    actionLabel: 'View job',
    actionTarget: '/security-printing/jobs/{{entityId}}',
  },
  SECURITYPRINTINGJOBAPPROVED: {
    type: 'security_printing.job_approved',
    title: 'Security printing job approved',
    body: 'Security printing job {{ENTITY_CODE}} was approved.',
    roleCodes: SEC,
  },
  SECURITYPRINTINGMACHINEASSIGNED: {
    type: 'security_printing.machine_assigned',
    title: 'Machine assigned',
    body: 'A machine was assigned to job {{ENTITY_CODE}}.',
    roleCodes: [...SEC, ...PROD],
  },
  SECURITYPRINTINGOPERATORASSIGNED: {
    type: 'security_printing.operator_assigned',
    title: 'Operator assigned',
    body: 'An operator was assigned to job {{ENTITY_CODE}}.',
    roleCodes: SEC,
  },
  SECURITYPRINTINGMATERIALSAUTHORIZED: {
    type: 'security_printing.materials_authorized',
    title: 'Materials authorized',
    body: 'Materials were authorized for job {{ENTITY_CODE}}.',
    roleCodes: SEC,
  },
  SECURITYPRINTINGMATERIALSISSUED: {
    type: 'security_printing.materials_issued',
    title: 'Materials issued',
    body: 'Materials were issued for job {{ENTITY_CODE}}.',
    roleCodes: [...SEC, ...WH],
  },
  SECURITYPRINTINGPRODUCTIONSTARTED: {
    type: 'security_printing.production_started',
    title: 'Security production started',
    body: 'Production started on job {{ENTITY_CODE}}.',
    roleCodes: SEC,
  },
  SECURITYPRINTINGPRODUCTIONCOMPLETED: {
    type: 'security_printing.production_completed',
    title: 'Security production completed',
    body: 'Production completed on job {{ENTITY_CODE}}.',
    roleCodes: SEC,
  },
  SECURITYPRINTINGQCPASS: {
    type: 'security_printing.qc_pass',
    title: 'QC passed',
    body: 'Quality control passed for job {{ENTITY_CODE}}.',
    roleCodes: [...SEC, ...QC],
  },
  SECURITYPRINTINGQCFAIL: {
    type: 'security_printing.qc_fail',
    title: 'QC failed',
    body: 'Quality control failed for job {{ENTITY_CODE}}.',
    roleCodes: [...SEC, ...QC],
    priority: 'HIGH',
    severity: 'WARN',
  },
  SECURITYPRINTINGPACKAGING: {
    type: 'security_printing.packaging',
    title: 'Job packaged',
    body: 'Job {{ENTITY_CODE}} entered packaging.',
    roleCodes: [...SEC, ...WH],
  },
  SECURITYPRINTINGSECURESTORAGE: {
    type: 'security_printing.secure_storage',
    title: 'Job in secure storage',
    body: 'Job {{ENTITY_CODE}} was moved to secure storage.',
    roleCodes: [...SEC, ...WH],
  },
  SECURITYPRINTINGDISPATCHED: {
    type: 'security_printing.dispatched',
    title: 'Job dispatched',
    body: 'Job {{ENTITY_CODE}} was dispatched.',
    roleCodes: [...SEC, ...LOG],
  },
  SECURITYPRINTINGDELIVERED: {
    type: 'security_printing.delivered',
    title: 'Job delivered',
    body: 'Job {{ENTITY_CODE}} was delivered.',
    roleCodes: [...SEC, ...SALES],
  },
  SECURITYPRINTINGHELD: {
    type: 'security_printing.held',
    title: 'Job held',
    body: 'Job {{ENTITY_CODE}} was placed on hold.',
    roleCodes: SEC,
    priority: 'HIGH',
  },
  SECURITYPRINTINGCANCELLED: {
    type: 'security_printing.cancelled',
    title: 'Job cancelled',
    body: 'Job {{ENTITY_CODE}} was cancelled.',
    roleCodes: SEC,
    priority: 'HIGH',
    severity: 'WARN',
  },
  SECURITYPRINTINGRESUMED: {
    type: 'security_printing.resumed',
    title: 'Job resumed',
    body: 'Job {{ENTITY_CODE}} was resumed.',
    roleCodes: SEC,
  },
  SECURITYPRINTINGRECONCILIATIONPASSED: {
    type: 'security_printing.reconciliation_passed',
    title: 'Reconciliation passed',
    body: 'Reconciliation passed for job {{ENTITY_CODE}}.',
    roleCodes: SEC,
  },
  SECURITYPRINTINGRECONCILIATIONINVESTIGATION: {
    type: 'security_printing.reconciliation_investigation',
    title: 'Reconciliation under investigation',
    body: 'Reconciliation for job {{ENTITY_CODE}} requires investigation.',
    roleCodes: SEC,
    priority: 'HIGH',
  },

  // ---------------- QR / Traceability ----------------
  QRGENERATED: {
    type: 'qr.generated',
    title: 'QR code generated',
    body: 'QR code {{ENTITY_CODE}} was generated.',
    roleCodes: SECADMIN,
  },
  QRSCANNED: {
    type: 'qr.scanned',
    title: 'QR code scanned',
    body: 'QR code {{ENTITY_CODE}} was scanned.',
    roleCodes: SECADMIN,
    email: false,
  },
  QRVOIDED: {
    type: 'qr.voided',
    title: 'QR code voided',
    body: 'QR code {{ENTITY_CODE}} was voided.',
    roleCodes: SECADMIN,
    priority: 'HIGH',
  },

  // ---------------- CRM ----------------
  CRMLEADCREATED: {
    type: 'crm.lead_created',
    title: 'Lead created',
    body: 'Lead {{ENTITY_CODE}} was created.',
    roleCodes: SALES,
  },
  CRMLEADCONVERTED: {
    type: 'crm.lead_converted',
    title: 'Lead converted',
    body: 'Lead {{ENTITY_CODE}} was converted.',
    roleCodes: SALES,
  },
  CRMLEADDISQUALIFIED: {
    type: 'crm.lead_disqualified',
    title: 'Lead disqualified',
    body: 'Lead {{ENTITY_CODE}} was disqualified.',
    roleCodes: SALES,
  },
  CRMOPPORTUNITYCREATED: {
    type: 'crm.opportunity_created',
    title: 'Opportunity created',
    body: 'Opportunity {{ENTITY_CODE}} was created.',
    roleCodes: SALES,
  },
  CRMOPPORTUNITYMOVED: {
    type: 'crm.opportunity_moved',
    title: 'Opportunity stage changed',
    body: 'Opportunity {{ENTITY_CODE}} moved to {{STAGE}}.',
    roleCodes: SALES,
    customer: {
      title: 'Update on {{ENTITY_CODE}}',
      body: 'Dear {{CUSTOMER_NAME}}, your enquiry "{{ENTITY_CODE}}" is now at {{STAGE}} with Hope Design.',
    },
  },
  CRMOPPORTUNITYWON: {
    type: 'crm.opportunity_won',
    title: 'Opportunity won',
    body: 'Opportunity {{ENTITY_CODE}} was won.',
    roleCodes: SALES,
    priority: 'HIGH',
    customer: {
      title: 'Thank you — {{ENTITY_CODE}}',
      body: 'Dear {{CUSTOMER_NAME}}, Hope Design is pleased to confirm we will proceed with {{ENTITY_CODE}}.',
    },
  },
  CRMOPPORTUNITYLOST: {
    type: 'crm.opportunity_lost',
    title: 'Opportunity lost',
    body: 'Opportunity {{ENTITY_CODE}} was lost.',
    roleCodes: SALES,
    severity: 'WARN',
  },
  CRMCUSTOMERCREATED: {
    type: 'crm.customer_created',
    title: 'Customer created',
    body: 'Customer {{ENTITY_CODE}} was added.',
    roleCodes: SALES,
  },
  CRMCOMPLAINTOPENED: {
    type: 'crm.complaint_opened',
    title: 'Complaint opened',
    body: 'Complaint {{ENTITY_CODE}} was opened.',
    roleCodes: SALES,
    priority: 'HIGH',
    customer: {
      title: 'We received your complaint {{ENTITY_CODE}}',
      body: 'Dear {{CUSTOMER_NAME}}, Hope Design has logged complaint {{ENTITY_CODE}}. Our team will follow up.',
    },
  },
  CRMCOMPLAINTRESOLVED: {
    type: 'crm.complaint_resolved',
    title: 'Complaint resolved',
    body: 'Complaint {{ENTITY_CODE}} was resolved.',
    roleCodes: SALES,
    customer: {
      title: 'Complaint {{ENTITY_CODE}} resolved',
      body: 'Dear {{CUSTOMER_NAME}}, Hope Design has resolved complaint {{ENTITY_CODE}}. Thank you for your patience.',
    },
  },

  // ---------------- Expenses & Requisitions ----------------
  EXPENSECREATED: {
    type: 'expense.created',
    title: 'Expense created',
    body: 'Expense {{ENTITY_CODE}} was created.',
    roleCodes: FIN,
  },
  EXPENSESUBMITTED: {
    type: 'expense.submitted',
    title: 'Expense submitted',
    body: 'Expense {{ENTITY_CODE}} was submitted for approval.',
    roleCodes: FIN,
    priority: 'HIGH',
    actionLabel: 'Review expense',
    actionTarget: '/expenses/{{entityId}}',
  },
  EXPENSEPOSTED: {
    type: 'expense.posted',
    title: 'Expense posted',
    body: 'Expense {{ENTITY_CODE}} was posted.',
    roleCodes: FIN,
  },
  EXPENSEPAID: {
    type: 'expense.paid',
    title: 'Expense paid',
    body: 'Expense {{ENTITY_CODE}} was paid.',
    roleCodes: FIN,
  },
  EXPENSEVOIDED: {
    type: 'expense.voided',
    title: 'Expense voided',
    body: 'Expense {{ENTITY_CODE}} was voided.',
    roleCodes: FIN,
  },
  REQUISITIONCREATED: {
    type: 'requisition.created',
    title: 'Requisition created',
    body: 'Requisition {{ENTITY_CODE}} was created.',
    roleCodes: [...PROC, ...WH],
  },
  REQUISITIONSUBMITTED: {
    type: 'requisition.submitted',
    title: 'Requisition submitted',
    body: 'Requisition {{ENTITY_CODE}} was submitted.',
    roleCodes: PROC,
  },
  REQUISITIONFULFILLED: {
    type: 'requisition.fulfilled',
    title: 'Requisition fulfilled',
    body: 'Requisition {{ENTITY_CODE}} was fulfilled.',
    roleCodes: [...PROC, ...WH],
  },
  REQUISITIONCANCELLED: {
    type: 'requisition.cancelled',
    title: 'Requisition cancelled',
    body: 'Requisition {{ENTITY_CODE}} was cancelled.',
    roleCodes: PROC,
  },

  // ---------------- Other modules ----------------
  CARTONSEALED: {
    type: 'carton.sealed',
    title: 'Carton sealed',
    body: 'Carton {{ENTITY_CODE}} was sealed.',
    roleCodes: [...WH, ...PROD],
    actionLabel: 'View batch',
    actionTarget: '/inventory/lots/{{entityId}}',
  },
  EFRISFISCALIZED: {
    type: 'efris.fiscalized',
    title: 'eFRIS fiscalized',
    body: 'Document {{ENTITY_CODE}} was fiscalized with eFRIS.',
    roleCodes: FIN,
  },
  EFRISREGISTERED: {
    type: 'efris.registered',
    title: 'eFRIS registered',
    body: 'eFRIS registration {{ENTITY_CODE}} was recorded.',
    roleCodes: FIN,
  },
};

// ---------------------------------------------------------------------------
// Module fallback: unmapped events still notify the owning department.
// ---------------------------------------------------------------------------

interface FallbackRule {
  re: RegExp;
  roleCodes: string[];
  priority?: NotificationPriority;
}

const MODULE_FALLBACK: FallbackRule[] = [
  { re: /^production\./, roleCodes: PROD },
  { re: /^procurement\./, roleCodes: PROC },
  { re: /^sales\./, roleCodes: SALES },
  { re: /^finance\./, roleCodes: FIN },
  { re: /^hr\./, roleCodes: HR },
  { re: /^assets?\./, roleCodes: ASSET },
  { re: /^quality\./, roleCodes: QC },
  { re: /^security_printing\./, roleCodes: SEC },
  { re: /^crm\./, roleCodes: SALES },
  { re: /^expense\./, roleCodes: FIN },
  { re: /^requisition\./, roleCodes: PROC },
  { re: /^qr\./, roleCodes: SECADMIN },
  { re: /^carton\./, roleCodes: [...WH, ...PROD] },
  { re: /^efris\./, roleCodes: FIN },
  { re: /^mrp\./, roleCodes: [...PLANNER, ...PROD] },
  { re: /^maintenance\./, roleCodes: MAINT },
  { re: /^logistics\./, roleCodes: LOG },
  { re: /^inventory\./, roleCodes: WH },
  { re: /^healthcare\./, roleCodes: HEALTH },
  { re: /^documents?\./, roleCodes: ['it_support_administrator'] },
  { re: /^workflows?\./, roleCodes: ['system_administrator'] },
  { re: /^admin\./, roleCodes: ['system_administrator'] },
  { re: /^payments?\./, roleCodes: FIN },
  { re: /^manufacturing\./, roleCodes: PROD },
];

const CONTACT_LATERAL = `
LEFT JOIN LATERAL (
  SELECT NULLIF(TRIM(email), '') AS email,
         COALESCE(NULLIF(TRIM(phone), ''), NULLIF(TRIM(mobile), '')) AS phone
    FROM contacts
   WHERE customer_id = c.id AND status = 'ACTIVE'
   ORDER BY is_primary DESC, id
   LIMIT 1
) ct ON true`;

interface PartyContact {
  email: string;
  phone: string;
  name: string;
  userId?: number | null;
}

function rowToParty(row: Record<string, unknown> | undefined, fallbackName: string): PartyContact | null {
  if (!row) return null;
  const userIdRaw = Number(row.user_id ?? row.userId ?? 0);
  return {
    email: String(row.email ?? '').trim(),
    phone: String(row.phone ?? '').trim(),
    name: String(row.name ?? '').trim() || fallbackName,
    userId: Number.isFinite(userIdRaw) && userIdRaw > 0 ? userIdRaw : null,
  };
}

async function lookupCustomerContact(
  client: pg.PoolClient,
  ctx: Ctx,
  entityType: string | null | undefined,
  entityId: number | null | undefined
): Promise<PartyContact | null> {
  if (!entityType || !entityId) return null;
  const tenantId = ctx.tenantId ?? 0;
  const fields = `COALESCE(NULLIF(TRIM(c.email), ''), ct.email) AS email,
          COALESCE(NULLIF(TRIM(c.phone), ''), ct.phone) AS phone,
          c.name AS name`;
  const sqlByType: Record<string, string> = {
    sales_quotations: `SELECT ${fields} FROM sales_quotations q JOIN customers c ON c.id = q.customer_id ${CONTACT_LATERAL} WHERE q.id = $1 AND q.tenant_id = $2`,
    sales_orders: `SELECT ${fields} FROM sales_orders o JOIN customers c ON c.id = o.customer_id ${CONTACT_LATERAL} WHERE o.id = $1 AND o.tenant_id = $2`,
    customer_invoices: `SELECT ${fields} FROM customer_invoices i JOIN customers c ON c.id = i.customer_id ${CONTACT_LATERAL} WHERE i.id = $1 AND i.tenant_id = $2`,
    receipts: `SELECT ${fields} FROM receipts r JOIN customers c ON c.id = r.customer_id ${CONTACT_LATERAL} WHERE r.id = $1 AND r.tenant_id = $2`,
    delivery_notes: `SELECT ${fields} FROM delivery_notes d JOIN sales_orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id ${CONTACT_LATERAL} WHERE d.id = $1 AND d.tenant_id = $2`,
    opportunities: `SELECT COALESCE(NULLIF(TRIM(c.email), ''), ct.email, NULLIF(TRIM(l.email), '')) AS email,
            COALESCE(NULLIF(TRIM(c.phone), ''), ct.phone, NULLIF(TRIM(l.phone), '')) AS phone,
            COALESCE(c.name, NULLIF(TRIM(l.company_name), ''), TRIM(CONCAT(COALESCE(l.first_name,''), ' ', COALESCE(l.last_name,'')))) AS name
       FROM opportunities o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN leads l ON l.id = o.lead_id
       ${CONTACT_LATERAL}
      WHERE o.id = $1 AND o.tenant_id = $2`,
    complaints: `SELECT ${fields} FROM complaints x JOIN customers c ON c.id = x.customer_id ${CONTACT_LATERAL} WHERE x.id = $1 AND x.tenant_id = $2`,
    customers: `SELECT ${fields} FROM customers c ${CONTACT_LATERAL} WHERE c.id = $1 AND c.tenant_id = $2`,
  };
  const sql = sqlByType[entityType];
  if (!sql) return null;
  const { rows } = await client.query(sql, [entityId, tenantId]);
  return rowToParty(rows[0], 'Customer');
}

async function fetchEmployee(client: pg.PoolClient, ctx: Ctx, employeeId: number): Promise<PartyContact | null> {
  const { rows } = await client.query(
    `SELECT e.email, e.phone,
            TRIM(CONCAT(COALESCE(e.first_name,''), ' ', COALESCE(e.last_name,''))) AS name,
            COALESCE(e.user_id, (SELECT u.id FROM users u WHERE u.employee_id = e.id AND u.tenant_id = e.tenant_id LIMIT 1)) AS user_id
       FROM employees e
      WHERE e.id = $1 AND e.tenant_id = $2`,
    [employeeId, ctx.tenantId]
  );
  return rowToParty(rows[0], 'Employee');
}

async function lookupEmployeeParty(
  client: pg.PoolClient,
  ctx: Ctx,
  e: EventLike
): Promise<PartyContact | null> {
  const fromPayload = Number((e.payload ?? {}).employeeId ?? (e.payload ?? {}).employee_id);
  if (Number.isFinite(fromPayload) && fromPayload > 0) return fetchEmployee(client, ctx, fromPayload);
  if (!e.entityType || e.entityId == null) return null;
  const entityId = Number(e.entityId);
  const tenantId = ctx.tenantId ?? 0;
  const sqlByType: Record<string, string> = {
    employees: `SELECT id FROM employees WHERE id = $1 AND tenant_id = $2`,
    leave_requests: `SELECT l.employee_id AS id FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = $1 AND e.tenant_id = $2`,
    timesheets: `SELECT employee_id AS id FROM timesheets WHERE id = $1 AND tenant_id = $2`,
    grievances: `SELECT employee_id AS id FROM grievances WHERE id = $1 AND tenant_id = $2`,
    warnings: `SELECT employee_id AS id FROM warnings WHERE id = $1 AND tenant_id = $2`,
    training_requests: `SELECT employee_id AS id FROM training_requests WHERE id = $1 AND tenant_id = $2`,
    'hr.loans': `SELECT employee_id AS id FROM employee_loans WHERE id = $1 AND tenant_id = $2`,
    'hr.advances': `SELECT employee_id AS id FROM salary_advances WHERE id = $1 AND tenant_id = $2`,
    'hr.contracts': `SELECT c.employee_id AS id FROM employment_contracts c JOIN employees e ON e.id = c.employee_id WHERE c.id = $1 AND e.tenant_id = $2`,
    'hr.final_settlements': `SELECT employee_id AS id FROM final_settlements WHERE id = $1 AND tenant_id = $2`,
    onboarding_instances: `SELECT employee_id AS id FROM onboarding_instances WHERE id = $1 AND tenant_id = $2`,
    offboarding_instances: `SELECT employee_id AS id FROM offboarding_instances WHERE id = $1 AND tenant_id = $2`,
  };
  const sql = sqlByType[e.entityType];
  if (!sql) return null;
  const { rows } = await client.query(sql, [entityId, tenantId]);
  const id = Number(rows[0]?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return fetchEmployee(client, ctx, id);
}

async function lookupSupplierContacts(
  client: pg.PoolClient,
  ctx: Ctx,
  entityType: string | null | undefined,
  entityId: number | null | undefined,
  payload?: Record<string, unknown>
): Promise<PartyContact[]> {
  const tenantId = ctx.tenantId ?? 0;
  const fetchSupplier = async (id: number) => {
    const { rows } = await client.query(
      `SELECT email, phone, name FROM suppliers WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rowToParty(rows[0], 'Supplier');
  };
  const fromIds = [payload?.supplierId, payload?.supplier_id]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  let ids: number[] = fromIds;
  if (ids.length === 0 && entityType && entityId) {
    if (entityType === 'rfqs') {
      const { rows } = await client.query(`SELECT supplier_id AS id FROM rfq_suppliers WHERE rfq_id = $1`, [entityId]);
      ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
    } else {
      const sqlByType: Record<string, string> = {
        suppliers: `SELECT id FROM suppliers WHERE id = $1 AND tenant_id = $2`,
        purchase_orders: `SELECT supplier_id AS id FROM purchase_orders WHERE id = $1 AND tenant_id = $2`,
        goods_receipts: `SELECT supplier_id AS id FROM goods_receipts WHERE id = $1 AND tenant_id = $2`,
        supplier_invoices: `SELECT supplier_id AS id FROM supplier_invoices WHERE id = $1 AND tenant_id = $2`,
        supplier_payments: `SELECT supplier_id AS id FROM supplier_payments WHERE id = $1 AND tenant_id = $2`,
        supplier_quotations: `SELECT supplier_id AS id FROM supplier_quotations WHERE id = $1 AND tenant_id = $2`,
      };
      const sql = sqlByType[entityType];
      if (sql) {
        const { rows } = await client.query(sql, [entityId, tenantId]);
        ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
      }
    }
  }
  const out: PartyContact[] = [];
  for (const id of [...new Set(ids)]) {
    const p = await fetchSupplier(id);
    if (p) out.push(p);
  }
  return out;
}

async function lookupCandidateContact(
  client: pg.PoolClient,
  ctx: Ctx,
  e: EventLike
): Promise<PartyContact | null> {
  const fromPayload = Number((e.payload ?? {}).candidateId ?? (e.payload ?? {}).candidate_id);
  const tenantId = ctx.tenantId ?? 0;
  const fetchCandidate = async (id: number) => {
    const { rows } = await client.query(
      `SELECT email, phone, TRIM(CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,''))) AS name
         FROM candidates WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rowToParty(rows[0], 'Candidate');
  };
  if (Number.isFinite(fromPayload) && fromPayload > 0) return fetchCandidate(fromPayload);
  if (!e.entityType || e.entityId == null) return null;
  const sqlByType: Record<string, string> = {
    candidates: `SELECT id FROM candidates WHERE id = $1 AND tenant_id = $2`,
    job_offers: `SELECT candidate_id AS id FROM job_offers WHERE id = $1 AND tenant_id = $2`,
    candidate_applications: `SELECT candidate_id AS id FROM candidate_applications WHERE id = $1 AND tenant_id = $2`,
  };
  const sql = sqlByType[e.entityType];
  if (!sql) return null;
  const { rows } = await client.query(sql, [Number(e.entityId), tenantId]);
  const id = Number(rows[0]?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return fetchCandidate(id);
}

function inferPartyKind(spec: EventSpec, eventType: string): EventSpec['party'] | undefined {
  if (spec.party) return spec.party;
  if (spec.customer) return 'customer';
  if (spec.email === false) return undefined;
  if (!eventType.startsWith('hr.')) return undefined;
  if (/(workforce_plan|vacancy_published|requisition_created|qr_scanned|qr_generated|id_generated|card_generated)/.test(eventType)) {
    return undefined;
  }
  if (/(offer|application|candidate)/.test(eventType)) return 'candidate';
  return 'employee';
}

async function lookupParties(
  client: pg.PoolClient,
  ctx: Ctx,
  kind: NonNullable<EventSpec['party']>,
  e: EventLike
): Promise<PartyContact[]> {
  const entityId = e.entityId != null ? Number(e.entityId) : null;
  if (kind === 'customer') {
    const one = await lookupCustomerContact(client, ctx, e.entityType, entityId);
    return one ? [one] : [];
  }
  if (kind === 'employee') {
    const one = await lookupEmployeeParty(client, ctx, e);
    return one ? [one] : [];
  }
  if (kind === 'supplier') return lookupSupplierContacts(client, ctx, e.entityType, entityId, e.payload);
  if (kind === 'candidate') {
    const one = await lookupCandidateContact(client, ctx, e);
    return one ? [one] : [];
  }
  return [];
}

function fallbackSpec(eventType: string): EventSpec | null {
  for (const f of MODULE_FALLBACK) {
    if (f.re.test(eventType)) {
      return {
        type: eventType,
        title: humanize(eventType),
        body: 'Event {{ENTITY_CODE}}',
        roleCodes: f.roleCodes,
        priority: f.priority,
      };
    }
  }
  return null;
}

/**
 * Mirror an emitted event into the instant-notification pipeline.
 *
 * Called from `emitEvent` (events.ts) as a fire-and-forget bridge. Resolves
 * the relevant roles, dedups against existing notifications, inserts through
 * `notifyUsers` (same tenant/company scope), then schedules the external
 * channel dispatch a few seconds later so the caller's transaction commits
 * first. Never throws — the business transaction must not be affected.
 */
export async function notifyFromEvent(
  client: pg.PoolClient,
  ctx: Ctx,
  e: EventLike
): Promise<void> {
  try {
    const eventType = String(e.eventType ?? '').trim();
    if (!eventType) return;
    const normKey = normEventKey(eventType);
    let spec = EVENT_NOTIFY_MAP[normKey];
    if (!spec) {
      const fb = fallbackSpec(eventType);
      if (!fb) return;
      spec = fb;
      const sev = String(e.severity ?? 'INFO').toUpperCase();
      if (sev === 'CRITICAL') spec.priority = 'CRITICAL';
      else if (sev === 'ERROR') spec.priority = 'URGENT';
      else if (sev === 'WARN') spec.priority = 'HIGH';
    }
    const vars = fillVars(e);
    const actionTarget = spec.actionTarget ? fill(spec.actionTarget, vars) : undefined;
    const partyKind = inferPartyKind(spec, eventType);
    let parties: PartyContact[] = [];
    if (partyKind) {
      try {
        parties = await lookupParties(client, ctx, partyKind, e);
      } catch (lookupErr) {
        console.error('[eventNotifications] party lookup', lookupErr instanceof Error ? lookupErr.message : lookupErr);
      }
    }
    const extraUsers = parties.map((p) => p.userId).filter((id): id is number => id != null && id > 0);
    const userIds = await resolveRecipients(client, ctx, { roleCodes: spec.roleCodes, userIds: extraUsers });
    const unique = await dedupUsers(client, ctx, userIds, spec.type, e.entityType, e.entityId);
    if (unique.length > 0) {
      const input: NotifyInput = {
        type: spec.type,
        title: fill(spec.title, vars),
        body: fill(spec.body, vars),
        entityType: e.entityType ?? undefined,
        entityId: e.entityId != null ? Number(e.entityId) : undefined,
        priority: spec.priority,
        severity: spec.severity,
        actionLabel: spec.actionLabel,
        actionTarget,
        channels: spec.email === false ? ['IN_APP'] : ['IN_APP', 'EMAIL'],
        data: { eventType, ...(e.payload ?? {}) },
      };
      const created = await notifyUsers(client, ctx, input, unique);
      if (created.length > 0) scheduleFlush();
    }
    const copy = spec.external ?? spec.customer ?? { title: spec.title, body: spec.body };
    const externalParties = parties.filter((p) => !p.userId && (p.email || p.phone));
    if (externalParties.length > 0) {
      const entityType = e.entityType ?? null;
      const entityId = e.entityId != null ? Number(e.entityId) : null;
      void detach(async (dclient, dctx) => {
        for (const party of externalParties) {
          const partyVars = { ...vars, PARTY_NAME: party.name, CUSTOMER_NAME: party.name };
          await notifyCustomer(dclient, dctx, {
            email: party.email,
            phone: party.phone,
            name: party.name,
            title: fill(copy.title, partyVars),
            body: fill(copy.body, partyVars),
            entityType,
            entityId,
          });
        }
      }, ctx).catch((err) => {
        console.error('[eventNotifications] party send', err instanceof Error ? err.message : err);
      });
    }
  } catch (err) {
    console.error('[eventNotifications]', err instanceof Error ? err.message : err);
  }
}
