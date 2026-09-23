-- 0177_professional_email_templates.sql
--
-- System mail was a single run-on sentence. Recipients now get a short
-- business letter: who it is for, the point, the facts on their own lines,
-- the action requested, and a sign-off. Every {{PLACEHOLDER}} already in
-- the template is kept, and no new one is introduced.
--
-- SECURITY_CODE body_html stays empty. The application draws the
-- verification-code panel itself; this row is the plain-text version.
-- Idempotent: each statement sets the same final copy.

-- ---------------------------------------------------------------- email

UPDATE email_templates SET
  subject = 'Invoice {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Please find invoice {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}}.

Invoice number: {{DOCUMENT_NUMBER}}
Amount due: {{AMOUNT}}
Due date: {{DUE_DATE}}

Please arrange payment by the due date. If the invoice has already been settled, you may disregard this message.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'INVOICE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Quotation {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Thank you for your enquiry. Please find quotation {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}}.

Quotation number: {{DOCUMENT_NUMBER}}
Amount: {{AMOUNT}}

The quotation is issued for your review. We would be pleased to proceed once you confirm it.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUOTATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Order confirmation {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Thank you for your order. {{COMPANY_NAME}} has confirmed order {{DOCUMENT_NUMBER}}.

Order number: {{DOCUMENT_NUMBER}}
Expected delivery: {{DELIVERY_DATE}}

We will write to you if the delivery date changes.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'ORDER_CONFIRMATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Credit note {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

{{COMPANY_NAME}} has issued credit note {{DOCUMENT_NUMBER}} against invoice {{INVOICE_NUMBER}}.

Credit note: {{DOCUMENT_NUMBER}}
Related invoice: {{INVOICE_NUMBER}}
Amount: {{AMOUNT}}

The credit will be applied to your account. Please contact our accounts team if you need a copy or a clarification.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CREDIT_NOTE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Payment reminder for invoice {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Our records show that invoice {{DOCUMENT_NUMBER}} is still outstanding.

Invoice number: {{DOCUMENT_NUMBER}}
Amount due: {{AMOUNT}}
Original due date: {{DUE_DATE}}

Please arrange settlement at your earliest convenience. If payment has already been made, send the payment reference so we can update your account.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_REMINDER' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Payment received for {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A payment has been received and posted.

Document: {{DOCUMENT_NUMBER}}
Amount: {{AMOUNT}}
Date posted: {{PAYMENT_DATE}}

No further action is required for this receipt.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_RECEIPT' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Statement of account: {{customer_name}}',
  body = $hdmail$Dear {{contact_name}},

Please find your statement of account with HOPE DESIGN GROUP LTD as at {{statement_date}}.

Account: {{customer_name}}
Outstanding balance: {{balance}}
Oldest open item: {{oldest_invoice}}
Due date: {{due_date}}

A detailed statement is attached. Please arrange settlement, or contact our accounts team if you wish to discuss the balance. If payment has already been made, send the payment reference so we can reconcile your account.

Kind regards,
Accounts
HOPE DESIGN GROUP LTD
{{company_phone}}$hdmail$
WHERE code = 'MAIL-STATEMENT-OUTSTANDING' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Delivery {{DOCUMENT_NUMBER}} has been dispatched',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Your delivery {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}} has left our premises.

Delivery number: {{DOCUMENT_NUMBER}}
Transport: {{TRANSPORT_MODE}}
Expected date: {{DELIVERY_DATE}}
Tracking reference: {{TRACKING_NO}}

Please contact us if the consignment does not arrive as expected.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DELIVERY_DISPATCH' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Delivery {{DOCUMENT_NUMBER}} has been dispatched',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Your delivery {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}} is on its way.

Delivery number: {{DOCUMENT_NUMBER}}
Expected date: {{DELIVERY_DATE}}

Please contact us if the receiving arrangements need to change.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DELIVERY_NOTIFICATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Purchase order {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{SUPPLIER_NAME}},

Please find purchase order {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}}.

Purchase order: {{DOCUMENT_NUMBER}}
Amount: {{AMOUNT}}

Please confirm acceptance and your expected delivery date.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PURCHASE_ORDER' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Goods receipt {{GRN_NO}} posted',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Goods have been received and recorded.

Goods receipt: {{GRN_NO}}
Purchase order: {{PO_NO}}
Supplier: {{SUPPLIER_NAME}}
Quantity received: {{QUANTITY}} {{UOM}}
Status: {{STATUS}}

Please review the receipt if a quantity or quality exception needs to be raised.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'GOODS_RECEIPT' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Welcome to {{COMPANY_NAME}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

Your account with {{COMPANY_NAME}} is ready.

Please sign in and change your password at first login. Keep your sign-in details private. Contact your manager or the human resources team if you cannot access the system.

We look forward to working with you.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WELCOME' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Leave approved for {{EMPLOYEE_NAME}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

Your leave request has been approved.

Start date: {{START_DATE}}
End date: {{END_DATE}}

Please hand over any time-sensitive work before the leave begins, and contact your manager if these dates need to change.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'LEAVE_APPROVAL' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Employment contract notice for {{EMPLOYEE_NAME}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

Your employment contract is approaching its end date.

Contract reference: {{DOCUMENT_NUMBER}}
Expiry date: {{EXPIRY_DATE}}

Please contact the human resources team to discuss renewal. This notice is a reminder of the date. It is not, by itself, a decision to renew or to end the contract.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CONTRACT_NOTIFICATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Payslip available for {{MONTH}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

Your payslip for {{MONTH}} is now available in the employee portal.

Please sign in to review it. Contact the payroll team if any figure needs to be checked.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYSLIP_NOTIFICATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Low stock: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Stock for the item below is under the safety level and needs attention.

Item: {{ITEM_NAME}} ({{ITEM_CODE}})
Available: {{AVAILABLE_QTY}} {{UOM}}
Safety stock: {{SAFETY_STOCK}} {{UOM}}

Please review replenishment before production or sales are affected.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'LOW_STOCK' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Reorder required: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

The item below has reached its reorder point.

Item: {{ITEM_NAME}} ({{ITEM_CODE}})
Available: {{AVAILABLE_QTY}} {{UOM}}
Reorder point: {{REORDER_POINT}} {{UOM}}

Please raise a purchase request so supply can be restored.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'STOCK_REORDER' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Production order {{ORDER_NO}} released',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} has been released and is ready to start.

Product: {{PRODUCT_NAME}}
Quantity: {{QUANTITY}} {{UOM}}
Scheduled start: {{START_DATE}}
Machine: {{MACHINE_NAME}}

Please confirm that materials and the machine are ready before the scheduled start.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_ORDER_RELEASED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Production order {{ORDER_NO}} completed',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} has been completed.

Product: {{PRODUCT_NAME}}
Good output: {{GOOD_QTY}} {{UOM}}
Waste: {{WASTE_QTY}} {{UOM}}

Please review the result and close any outstanding quality or inventory steps.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_COMPLETED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Production delay on order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} is behind schedule and needs a review.

Delay: {{DELAY_MINUTES}} minutes
Progress: {{PROGRESS_PERCENT}}%

Please identify the cause and advise whether the plan should be revised.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_DELAYED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Shift summary: {{SHIFT_NAME}} on {{SHIFT_DATE}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please find the production summary for the {{SHIFT_NAME}} shift on {{SHIFT_DATE}}.

Output: {{OUTPUT_QTY}} {{UOM}}
Target: {{TARGET_QTY}} {{UOM}}
Achievement: {{ACHIEVEMENT_PERCENT}}%
Waste: {{WASTE_PERCENT}}%

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'SHIFT_SUMMARY' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Machine breakdown: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A breakdown has been reported and production may be affected.

Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
Downtime so far: {{DOWNTIME_MINUTES}} minutes
Affected order: {{ORDER_NO}}

Please arrange attendance and keep the affected order updated until the machine returns to service.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MACHINE_BREAKDOWN' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Maintenance due: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Scheduled maintenance is due for the machine below.

Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
Due date: {{DUE_DATE}}

Please book the maintenance window and confirm that production can be covered while the machine is stopped.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MAINTENANCE_DUE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Material shortage on order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} does not have enough material to continue as planned.

Material: {{MATERIAL_NAME}}
Required: {{REQUIRED_QTY}} {{UOM}}
Available: {{AVAILABLE_QTY}} {{UOM}}
Action needed by: {{DEADLINE}}

Please arrange supply, or revise the order, before the deadline.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MATERIAL_SHORTAGE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Work order {{WORK_ORDER_NO}} is overdue',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

The work order below has passed its due date.

Work order: {{WORK_ORDER_NO}}
Product: {{PRODUCT_NAME}}
Due date: {{DUE_DATE}}
Status: {{STATUS}}

Please update the order with a revised completion date, or with the reason it remains open.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WORK_ORDER_OVERDUE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Asset {{ASSET_NO}} is overdue for return',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

The asset below was not returned by the expected date.

Asset: {{ASSET_NO}} ({{ASSET_NAME}})
Custodian: {{CUSTODIAN_NAME}}
Expected return: {{EXPECTED_RETURN_DATE}}

Please confirm where the asset is and arrange its return, or record an approved extension.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CUSTODY_OVERDUE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Inspection required for batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A batch is ready for inspection and should not move forward until it is cleared.

Batch: {{BATCH_NO}}
Product: {{PRODUCT_NAME}}
Inspection: {{INSPECTION_TYPE}}
Location: {{INSPECTION_POINT}}
Complete by: {{DEADLINE}}

Please complete the inspection and record the result before the deadline.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_INSPECTION_REQUEST' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Quality hold on batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A batch has been placed on quality hold. It must not be used or dispatched.

Batch: {{BATCH_NO}}
Product: {{PRODUCT_NAME}}
Quantity blocked: {{QUANTITY}} {{UOM}}
Reason: {{REASON}}

Please keep the quantity segregated until quality releases it or rejects it.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_HOLD' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Batch {{BATCH_NO}} rejected',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A batch has failed inspection.

Batch: {{BATCH_NO}}
Product: {{PRODUCT_NAME}}
Rejected quantity: {{QUANTITY}} {{UOM}}
Disposition: {{DISPOSITION}}

Please carry out the stated disposition and keep the rejected quantity out of usable stock.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_REJECTED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Your HOPE DESIGN verification code',
  body = $hdmail$Hello {{RECIPIENT_NAME}},

Use the verification code below to {{PURPOSE}}.

{{CODE}}

This code expires in {{TTL_MINUTES}} minutes and can be used only once. Do not share it with anyone, including members of staff.

If you did not request this code, you can ignore this message. Please do not forward it.

{{COMPANY_NAME}}$hdmail$
WHERE code = 'SECURITY_CODE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Internal memorandum: {{memo_subject}}',
  body = $hdmail$TO: {{recipients}}
FROM: {{sender_name}}, {{sender_title}}
DATE: {{memo_date}}
REFERENCE: {{reference}}
SUBJECT: {{memo_subject}}

{{body}}

{{sender_name}}
{{sender_title}}
HOPE DESIGN GROUP LTD$hdmail$
WHERE code = 'MAIL-INTERNAL-MEMO' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Meeting invitation: {{meeting_title}}',
  body = $hdmail$Dear {{recipient_name}},

You are invited to the meeting below. Please confirm whether you will attend.

Meeting: {{meeting_title}}
Date: {{meeting_date}}
Time: {{meeting_time}}
Venue: {{meeting_venue}}

Agenda:
{{agenda}}

Kind regards,
{{sender_name}}
HOPE DESIGN GROUP LTD$hdmail$
WHERE code = 'MAIL-MEETING-REQUEST' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = '{{subject}}',
  body = $hdmail${{recipient_name}}
{{recipient_address}}

Dear {{recipient_name}},

{{body}}

Yours faithfully,

{{sender_name}}
{{sender_title}}
HOPE DESIGN GROUP LTD$hdmail$
WHERE code = 'MAIL-OFFICIAL-LETTER' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Acknowledgement of secure job {{job_number}}',
  body = $hdmail$Dear {{recipient_name}},

This message acknowledges receipt and control of the secure print job below.

Job number: {{job_number}}
Product: {{product_name}}
Quantity: {{quantity}}
Classification: {{classification}}
Custody holder: {{custodian}}

This correspondence is controlled. Do not forward, copy, or discuss it outside the named custody chain.

Kind regards,
HOPE DESIGN GROUP LTD$hdmail$
WHERE code = 'MAIL-SECURITY-ACK' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Request received: {{ticket_number}}',
  body = $hdmail$Dear {{requester_name}},

Your request has been logged with the HOPE DESIGN Service Desk. Please quote the ticket number in any follow-up.

Ticket: {{ticket_number}}
Subject: {{ticket_subject}}
Priority: {{priority}}
Logged: {{logged_at}}

We will write to you as the request progresses.

Kind regards,
HOPE DESIGN Service Desk$hdmail$
WHERE code = 'MAIL-TICKET-ACK' AND scope = 'SYSTEM';

-- ----------------------------------------------------- notification email

UPDATE notification_templates SET
  subject = 'Approval required: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A document has been submitted for your approval.

Document: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}
Amount: {{AMOUNT}}
Submitted by: {{REQUESTED_BY}}

Please review it here:
{{APPROVAL_LINK}}

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'APPROVAL_REQUIRED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Approval escalated: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

An approval has been waiting since {{SUBMITTED_AT}} and has now been escalated for management attention.

Document: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}

Please review it here:
{{APPROVAL_LINK}}

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'APPROVAL_ESCALATED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Inspection due: {{ASSET_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

An asset is due for inspection.

Asset: {{ASSET_NAME}} ({{ASSET_NO}})
Due date: {{DUE_DATE}}

Please schedule the inspection and record the result.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'ASSET_INSPECTION_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Maintenance due: {{ASSET_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Scheduled maintenance is due for the asset below.

Asset: {{ASSET_NAME}} ({{ASSET_NO}})
Due date: {{DUE_DATE}}

Please book the maintenance window before the due date.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'ASSET_MAINTENANCE_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Contract expiring: {{EMPLOYEE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

An employment contract is approaching its end date and needs a renewal decision.

Employee: {{EMPLOYEE_NAME}}
Contract type: {{CONTRACT_TYPE}}
Expiry date: {{EXPIRY_DATE}}
Days remaining: {{DAYS_REMAINING}}

Please coordinate the renewal with the employee and human resources.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CONTRACT_EXPIRY' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Asset {{ASSET_NO}} is overdue for return',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

The asset below was not returned by the expected date.

Asset: {{ASSET_NO}} ({{ASSET_NAME}})
Expected return: {{EXPECTED_RETURN_DATE}}

Please confirm where the asset is and arrange its return, or record an approved extension.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CUSTODY_OVERDUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Delivery {{DOCUMENT_NUMBER}} dispatched',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Delivery {{DOCUMENT_NUMBER}} has been dispatched.

Expected date: {{DELIVERY_DATE}}

Please contact us if the delivery does not arrive as expected.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DELIVERY_DISPATCHED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Document expiring: {{DOC_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A controlled document is approaching its expiry date.

Document: {{DOC_NO}}
Title: {{TITLE}}
Expires: {{EXPIRES_AT}}

Please review it and arrange renewal or withdrawal before it expires.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DOCUMENT_EXPIRY' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Document added: {{DOCUMENT_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A document has been added to a record you follow.

Document: {{DOCUMENT_NAME}}
Record: {{ENTITY_TYPE}} {{ENTITY_CODE}}
Uploaded by: {{UPLOADED_BY}}

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DOCUMENT_UPLOADED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Stock with no movement: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

The item below has had no stock movement for an extended period and should be reviewed.

Item: {{ITEM_NAME}} ({{ITEM_CODE}})
On hand: {{ON_HAND}}
Days without movement: {{DAYS}}

Please confirm whether the quantity should be retained, transferred, or written down.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'INVENTORY_DEAD_STOCK' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Low stock: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Stock for the item below is under the safety level and needs attention.

Item: {{ITEM_NAME}} ({{ITEM_CODE}})
Available: {{AVAILABLE_QTY}} {{UOM}}
Safety stock: {{SAFETY_STOCK}} {{UOM}}

Please review replenishment before production or sales are affected.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'LOW_STOCK' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Machine breakdown: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A breakdown has been reported and production may be affected.

Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
Downtime so far: {{DOWNTIME_MINUTES}} minutes

Please arrange attendance and keep the affected work updated until the machine returns to service.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MACHINE_BREAKDOWN' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Maintenance due: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Scheduled maintenance is due for the machine below.

Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
Due date: {{DUE_DATE}}

Please book the maintenance window and confirm that production can be covered while the machine is stopped.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MAINTENANCE_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Material shortage on order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} does not have enough material to continue as planned.

Material: {{MATERIAL_NAME}}
Required: {{REQUIRED_QTY}} {{UOM}}
Available: {{AVAILABLE_QTY}} {{UOM}}

Please arrange supply, or revise the order.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MATERIAL_SHORTAGE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Password change required for {{EMAIL}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A user account requires a password change.

Name: {{DISPLAY_NAME}}
Email: {{EMAIL}}
Days since the last change: {{DAYS}}

Please ask the user to set a new password, or reset it if they can no longer sign in.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PASSWORD_EXPIRY' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Payment still outstanding: {{PAY_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

An approved payment has not been released within the expected time.

Payment: {{PAY_NO}}
Payee: {{PAYEE}}
Amount: {{AMOUNT}} {{CURRENCY}}
Days since approval: {{DAYS}}

Please arrange payment, or record the reason it is being held.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Payment received for {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A payment has been received and posted.

Document: {{DOCUMENT_NUMBER}}
Amount: {{AMOUNT}}
Date posted: {{PAYMENT_DATE}}

No further action is required for this receipt.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_RECEIVED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Production order {{ORDER_NO}} completed',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} has been completed.

Good output: {{GOOD_QTY}} {{UOM}}

Please review the result and close any outstanding quality or inventory steps.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_COMPLETED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Production delay on order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} is behind schedule and needs a review.

Delay: {{DELAY_MINUTES}} minutes
Progress: {{PROGRESS_PERCENT}}%

Please identify the cause and advise whether the plan should be revised.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_DELAYED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Production order {{ORDER_NO}} released',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Production order {{ORDER_NO}} has been released and is ready to start.

Product: {{PRODUCT_NAME}}
Quantity: {{QUANTITY}} {{UOM}}

Please confirm that materials and the machine are ready.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_ORDER_RELEASED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Quality hold on batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A batch has been placed on quality hold. It must not be used or dispatched.

Batch: {{BATCH_NO}}
Product: {{PRODUCT_NAME}}
Quantity blocked: {{QUANTITY}} {{UOM}}
Reason: {{REASON}}

Please keep the quantity segregated until quality releases it or rejects it.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_HOLD' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Inspection awaiting review: {{INSPECTION_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A quality inspection is waiting for review.

Inspection: {{INSPECTION_NO}}
Type: {{KIND}}
Product: {{PRODUCT_NAME}}
Batch: {{BATCH_NO}}

Please complete the review and record the decision.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_INSPECTION_PENDING' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Inspection required for batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A batch is ready for inspection and should not move forward until it is cleared.

Batch: {{BATCH_NO}}
Product: {{PRODUCT_NAME}}
Inspection: {{INSPECTION_TYPE}}
Location: {{INSPECTION_POINT}}

Please complete the inspection and record the result.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_INSPECTION_REQUEST' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Quarantine review: {{PRODUCT_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Stock has remained in quarantine longer than expected and needs a decision.

Product: {{PRODUCT_NAME}}
Quantity: {{QUANTITY}}
Days in quarantine: {{DAYS}}
Reason: {{REASON}}

Please release it, reject it, or record a further hold.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUARANTINE_AGING' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Reorder required: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

The item below has reached its reorder point.

Item: {{ITEM_NAME}} ({{ITEM_CODE}})
Available: {{AVAILABLE_QTY}} {{UOM}}
Reorder point: {{REORDER_POINT}} {{UOM}}

Please raise a purchase request so supply can be restored.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'STOCK_REORDER' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Work order {{WORK_ORDER_NO}} is overdue',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

The work order below has passed its due date.

Work order: {{WORK_ORDER_NO}}
Product: {{PRODUCT_NAME}}
Due date: {{DUE_DATE}}

Please update the order with a revised completion date, or with the reason it remains open.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WORK_ORDER_OVERDUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'No recent activity on work order {{WORK_ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A work order has not been updated within the expected time.

Work order: {{WORK_ORDER_NO}}
Product: {{PRODUCT_NAME}}
Hours since the last update: {{STALE_HOURS}}

Please review the order and record the current status.

Kind regards,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WORK_ORDER_STALE' AND channel = 'EMAIL';
