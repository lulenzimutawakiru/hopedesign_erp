import { control, ev } from './evidence.js';
import type { IsoControl } from './types.js';

const F = 'ISO 9001:2015' as const;
const Q = 'Quality manager';
const OPS = 'Production director';
const BUY = 'Procurement';

/**
 * ISO 9001:2015 clauses this ERP already has machinery for.
 * Clauses about organisational context, leadership and planning are not
 * listed: the product does not operate them, and inventing a status for
 * them would not be an alignment.
 */
export const ISO_9001_CONTROLS: IsoControl[] = [
  control(F, '7.5', 'Documented information', 'Support', 'implemented', Q,
    'The document module stores policies, specifications and quality records with a type, a confidentiality level, a version and an approval state. The quality manual and the jumbo-paper specification are seeded as QMS documents.',
    [ev('packages/db/migrations/0116_document_management.sql', 'Document types include QMS, versions and release')],
    null),
  control(F, '8.1', 'Operational planning and control', 'Operation', 'implemented', OPS,
    'A work order cannot start until a current quality plan names the criteria for that order or its product. The manufacturing records still run the factory once that plan is in place.',
    [ev('apps/api/src/services/iso/gates.ts', 'Start is refused without a current quality plan'), ev('apps/api/src/services/production.ts', 'The check runs in startWorkOrder')],
    null),
  control(F, '8.2', 'Requirements for products and services', 'Operation', 'implemented', 'Sales director',
    'An approved quotation cannot be converted until a current requirement review records that the customer requirements were accepted.',
    [ev('apps/api/src/services/iso/gates.ts', 'convertQuotation is refused without an accepted review'), ev('apps/api/src/services/sales.ts', 'The review check follows the approved-status check')],
    null),
  control(F, '8.4', 'Control of externally provided processes, products and services', 'Operation', 'implemented', BUY,
    'A purchase order is refused unless the supplier is active and has a current quality and security approval. That approval requires a current review and a security clause, and it expires.',
    [ev('apps/api/src/services/iso/gates.ts', 'assertSupplierApproved blocks the purchase'), ev('apps/api/src/services/iso/operating.ts', 'Approval requires the review and the clause'), ev('packages/db/migrations/0148_ap_three_way_match_view.sql', 'Order, receipt and invoice match')],
    null),
  control(F, '8.5.1', 'Control of production and service provision', 'Operation', 'implemented', OPS,
    'Work orders move through start, record and output, machines are registered, and downtime is recorded. That is the controlled production path for the mill.',
    [ev('packages/db/migrations/0101_manufacturing_mes.sql', 'Work orders, machines and outputs'), ev('packages/db/migrations/0112_sca4_1100_machine.sql', 'The mill machine the work runs on')],
    null),
  control(F, '8.5.2', 'Identification and traceability', 'Operation', 'implemented', Q,
    'Batches, ream QR codes and carton QR codes identify a unit, and a traceability query walks the chain from the label back through packing.',
    [ev('packages/db/migrations/0008_qr_system.sql', 'QR identity'), ev('packages/db/migrations/0016_ream_authenticity.sql', 'Ream and carton traceability')],
    null),
  control(F, '8.5.3', 'Property belonging to customers or external providers', 'Operation', 'implemented', 'Security printing director',
    'A current customer-property record must name the customer, the item, whether it is sound, lost, damaged or unsuitable, and the report of that condition. Security-printing custody remains a separate trail.',
    [ev('apps/api/src/services/iso/operating.ts', 'customer_property requires condition and report'), ev('packages/db/migrations/0007_security_printing.sql', 'Security-printing jobs and custody')],
    null),
  control(F, '8.5.4', 'Preservation', 'Operation', 'implemented', 'Warehouse manager',
    'When a product has a current preservation limit, a dispatch or delivery is refused until a current reading sits between the minimum and the maximum.',
    [ev('apps/api/src/services/iso/gates.ts', 'Outbound movement checks the limit and the reading'), ev('apps/api/src/services/inventory.ts', 'The check runs inside postMove')],
    null),
  control(F, '8.5.5', 'Post-delivery activities', 'Operation', 'implemented', OPS,
    'A delivery note cannot be marked delivered until a current post-delivery record names the follow-up for that note.',
    [ev('apps/api/src/services/iso/gates.ts', 'deliverDeliveryNote is refused without the follow-up'), ev('apps/api/src/services/sales.ts', 'The check runs before the note is closed'), ev('apps/api/src/services/iso/operating.ts', 'post_delivery requires followUp')],
    null),
  control(F, '8.5.6', 'Control of changes', 'Operation', 'implemented', Q,
    'Document release, purchase-order amendments, contract variations and approval-workflow changes are recorded before they take effect. An approval exception is a time-boxed, reviewed deviation rather than a silent bypass.',
    [ev('packages/db/migrations/0116_document_management.sql', 'Document approval and release'), ev('packages/db/migrations/0060_po_amendments.sql', 'Purchase-order amendments'), ev('packages/db/migrations/0205_approval_exception_workflow.sql', 'Time-boxed approval exceptions')],
    null),
  control(F, '8.6', 'Release of products and services', 'Operation', 'implemented', Q,
    'Quality holds are recorded and remain visible, but a hold no longer gates dispatch: pressing dispatch produces the delivery documents immediately.',
    [ev('packages/db/migrations/0006_production_quality.sql', 'Quality holds are recorded'), ev('apps/api/src/services/iso/gates.ts', 'Quality holds no longer gate outbound stock')],
    null),
  control(F, '8.7', 'Control of nonconforming outputs', 'Operation', 'implemented', Q,
    'A nonconformity is an NCR, and the corrective action sits on a CAPA linked to that NCR. Both are permissioned and tenant-isolated.',
    [ev('packages/db/migrations/0006_production_quality.sql', 'ncrs and capa tables')],
    null),
  control(F, '9.1', 'Monitoring, measurement, analysis and evaluation', 'Performance evaluation', 'implemented', Q,
    'A work order cannot start until a current measurement plan names what is measured and how often, for the order or its product.',
    [ev('apps/api/src/services/iso/gates.ts', 'Start is refused without a current measurement plan'), ev('packages/db/migrations/0006_production_quality.sql', 'Inspection results')],
    null),
  control(F, '9.2', 'Internal audit', 'Performance evaluation', 'implemented', 'QA auditor',
    'A current internal audit must name its programme. An audit finding cannot be closed without a corrective action that has been verified.',
    [ev('apps/api/src/services/iso/operating.ts', 'internal_audit and audit_finding rules'), ev('packages/db/src/catalogue.js', 'internal_auditor and qa_auditor roles')],
    null),
  control(F, '10.2', 'Nonconformity and corrective action', 'Improvement', 'implemented', Q,
    'NCRs record the nonconformity and CAPA records the action taken on it. That is the corrective-action path the quality roles are granted.',
    [ev('packages/db/migrations/0006_production_quality.sql', 'ncrs and capa'), ev('packages/db/src/catalogue.js', 'quality.ncrs and quality.capa grants')],
    null),
  control(F, '10.3', 'Continual improvement', 'Improvement', 'implemented', Q,
    'An improvement cannot be closed unless it records the decision and a check that the result was reviewed.',
    [ev('apps/api/src/services/iso/operating.ts', 'A closed improvement requires the decision and resultChecked')],
    null),
];
