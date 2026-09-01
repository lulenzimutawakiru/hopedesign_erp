import pg from 'pg';
import { Ctx } from '../db.js';
import {
  notifyUsers,
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
const HR = ['hr_manager', 'hr_director'];
const SALES = ['sales_manager', 'sales_director'];
const ASSET = ['asset_manager', 'asset_finance'];
const MAINT = ['maintenance_manager', 'maintenance_supervisor'];
const QC = ['quality_manager', 'quality_inspector'];
const WH = ['warehouse_manager', 'inventory_controller'];
const SEC = ['security_printing_manager', 'secure_job_approver'];
const SECADMIN = ['security_administrator'];
const LOG = ['logistics_manager', 'dispatch_manager'];

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
  },
  PROCUREMENTPOAPPROVED: {
    type: 'procurement.po_approved',
    title: 'Purchase order approved',
    body: 'Purchase order {{ENTITY_CODE}} was approved.',
    roleCodes: PROC,
    priority: 'HIGH',
    actionLabel: 'View purchase order',
    actionTarget: '/procurement/purchase-orders/{{entityId}}',
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
  SALESQUOTATIONCONVERTED: {
    type: 'sales.quotation_converted',
    title: 'Quotation converted',
    body: 'Quotation {{ENTITY_CODE}} was converted to a sales order.',
    roleCodes: SALES,
  },
  SALESINVOICECREATED: {
    type: 'sales.invoice_created',
    title: 'Sales invoice created',
    body: 'Sales invoice {{ENTITY_CODE}} was created.',
    roleCodes: [...SALES, ...FIN],
    actionLabel: 'View invoice',
    actionTarget: '/sales/invoices/{{entityId}}',
  },
  SALESRECEIPTPOSTED: {
    type: 'sales.receipt_posted',
    title: 'Payment received',
    body: 'A receipt was posted against {{ENTITY_CODE}}.',
    roleCodes: FIN,
  },
  SALESDELIVERYDISPATCHED: {
    type: 'sales.delivery_dispatched',
    title: 'Delivery dispatched',
    body: 'Delivery {{ENTITY_CODE}} was dispatched.',
    roleCodes: [...SALES, ...LOG],
    actionLabel: 'Track delivery',
    actionTarget: '/logistics/deliveries/{{entityId}}',
  },
  SALESDELIVERYDELIVERED: {
    type: 'sales.delivery_delivered',
    title: 'Delivery completed',
    body: 'Delivery {{ENTITY_CODE}} was marked delivered.',
    roleCodes: SALES,
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
    roleCodes: HR,
  },
  HRAPPLICATIONSUBMITTED: {
    type: 'hr.application_submitted',
    title: 'Job application submitted',
    body: 'An application was submitted for {{ENTITY_CODE}}.',
    roleCodes: HR,
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
    roleCodes: [...FIN, ...HR],
  },
  HRPAYROLLPAYMENTCONFIRMED: {
    type: 'hr.payroll.payment_confirmed',
    title: 'Payroll payment confirmed',
    body: 'Payroll payment batch {{ENTITY_CODE}} was confirmed.',
    roleCodes: FIN,
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
  CRMOPPORTUNITYWON: {
    type: 'crm.opportunity_won',
    title: 'Opportunity won',
    body: 'Opportunity {{ENTITY_CODE}} was won.',
    roleCodes: SALES,
    priority: 'HIGH',
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
];

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
    const userIds = await resolveRecipients(client, ctx, { roleCodes: spec.roleCodes });
    if (userIds.length === 0) return;
    const unique = await dedupUsers(client, ctx, userIds, spec.type, e.entityType, e.entityId);
    if (unique.length === 0) return;
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
  } catch (err) {
    console.error('[eventNotifications]', err instanceof Error ? err.message : err);
  }
}
