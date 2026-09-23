-- 0178_email_house_style.sql
--
-- Bring every system email into the same form as the official letter:
-- a salutation, one sentence of purpose, a schedule of particulars, one
-- request, and "Yours faithfully". Placeholders are unchanged.
-- Particulars use a bullet so the branded mail shell renders them as a list.

-- ---------------------------------------------------------------- email

UPDATE email_templates SET
  subject = 'Invoice {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

We write in connection with invoice {{DOCUMENT_NUMBER}}, issued by {{COMPANY_NAME}}.

The particulars are as follows:

• Invoice number: {{DOCUMENT_NUMBER}}
• Amount due: {{AMOUNT}}
• Due date: {{DUE_DATE}}

Kindly arrange payment on or before the due date. If settlement has already been made, no further action is required.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'INVOICE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Quotation {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Thank you for your enquiry. We are pleased to submit quotation {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}} for your consideration.

The particulars are as follows:

• Quotation number: {{DOCUMENT_NUMBER}}
• Amount: {{AMOUNT}}

This quotation is subject to your written confirmation. We shall be glad to proceed upon receipt of your instructions.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUOTATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Order confirmation {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

We acknowledge and confirm your order {{DOCUMENT_NUMBER}} with {{COMPANY_NAME}}.

The particulars are as follows:

• Order number: {{DOCUMENT_NUMBER}}
• Expected delivery: {{DELIVERY_DATE}}

We shall advise you in writing should the delivery date change.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'ORDER_CONFIRMATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Credit note {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

{{COMPANY_NAME}} has issued credit note {{DOCUMENT_NUMBER}} in respect of invoice {{INVOICE_NUMBER}}.

The particulars are as follows:

• Credit note: {{DOCUMENT_NUMBER}}
• Related invoice: {{INVOICE_NUMBER}}
• Amount: {{AMOUNT}}

The credit will be applied to your account. Kindly contact our accounts office should you require a copy or any clarification.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CREDIT_NOTE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Payment reminder: invoice {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

Our records show that invoice {{DOCUMENT_NUMBER}} remains outstanding. We should be grateful for your early settlement.

The particulars are as follows:

• Invoice number: {{DOCUMENT_NUMBER}}
• Amount outstanding: {{AMOUNT}}
• Due date: {{DUE_DATE}}

If payment has already been remitted, kindly forward the payment reference so that your account may be updated.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_REMINDER' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Payment received: {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

We confirm that a payment has been received and posted to the account.

The particulars are as follows:

• Document: {{DOCUMENT_NUMBER}}
• Amount: {{AMOUNT}}
• Date posted: {{PAYMENT_DATE}}

No further action is required in respect of this receipt.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_RECEIPT' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Statement of account: {{customer_name}}',
  body = $hdmail$Dear {{contact_name}},

Please find your statement of account with HOPE DESIGN GROUP LTD as at {{statement_date}}.

The particulars are as follows:

• Account: {{customer_name}}
• Outstanding balance: {{balance}}
• Oldest open item: {{oldest_invoice}}
• Due date: {{due_date}}

A detailed statement is attached. Kindly arrange settlement, or contact our accounts office should you wish to discuss the balance. If payment has already been made, please forward the payment reference so that the account may be reconciled.

Yours faithfully,
Accounts
HOPE DESIGN GROUP LTD
{{company_phone}}$hdmail$
WHERE code = 'MAIL-STATEMENT-OUTSTANDING' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Delivery dispatched: {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

We write to advise that delivery {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}} has left our premises.

The particulars are as follows:

• Delivery number: {{DOCUMENT_NUMBER}}
• Mode of transport: {{TRANSPORT_MODE}}
• Expected date: {{DELIVERY_DATE}}
• Tracking reference: {{TRACKING_NO}}

Kindly contact us should the consignment not arrive as advised.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DELIVERY_DISPATCH' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Delivery dispatched: {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

We write to advise that delivery {{DOCUMENT_NUMBER}} from {{COMPANY_NAME}} is in transit.

The particulars are as follows:

• Delivery number: {{DOCUMENT_NUMBER}}
• Expected date: {{DELIVERY_DATE}}

Kindly contact us should the receiving arrangements need to be changed.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DELIVERY_NOTIFICATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Purchase order {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{SUPPLIER_NAME}},

Please find purchase order {{DOCUMENT_NUMBER}}, issued by {{COMPANY_NAME}}.

The particulars are as follows:

• Purchase order: {{DOCUMENT_NUMBER}}
• Amount: {{AMOUNT}}

Kindly confirm acceptance of this order and state your expected delivery date.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PURCHASE_ORDER' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Goods receipt {{GRN_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Goods have been received and entered in the records.

The particulars are as follows:

• Goods receipt: {{GRN_NO}}
• Purchase order: {{PO_NO}}
• Supplier: {{SUPPLIER_NAME}}
• Quantity received: {{QUANTITY}} {{UOM}}
• Status: {{STATUS}}

Kindly review the receipt should a quantity or quality exception require to be raised.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'GOODS_RECEIPT' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Welcome to {{COMPANY_NAME}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

Your account with {{COMPANY_NAME}} has been created and is ready for use.

Kindly sign in and change your password at first login. Please keep your sign-in details confidential. Should you be unable to gain access, contact your manager or the human resources office.

We look forward to your contribution.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WELCOME' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Leave approved: {{EMPLOYEE_NAME}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

Your application for leave has been approved.

The particulars are as follows:

• Start date: {{START_DATE}}
• End date: {{END_DATE}}

Kindly hand over any time-sensitive duties before the leave commences, and inform your manager should these dates require amendment.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'LEAVE_APPROVAL' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Contract notice: {{EMPLOYEE_NAME}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

We write to advise that your contract of employment is approaching its expiry.

The particulars are as follows:

• Contract reference: {{DOCUMENT_NUMBER}}
• Expiry date: {{EXPIRY_DATE}}

Kindly contact the human resources office to discuss renewal. This notice records the expiry date only. It does not, of itself, constitute a decision to renew or to determine the contract.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CONTRACT_NOTIFICATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Payslip for {{MONTH}}',
  body = $hdmail$Dear {{EMPLOYEE_NAME}},

Your payslip for {{MONTH}} is now available on the employee portal.

Kindly sign in and review it. Should any figure require explanation, please contact the payroll office.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYSLIP_NOTIFICATION' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Low stock: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the item below has fallen beneath its safety level.

The particulars are as follows:

• Item: {{ITEM_NAME}} ({{ITEM_CODE}})
• Quantity available: {{AVAILABLE_QTY}} {{UOM}}
• Safety stock: {{SAFETY_STOCK}} {{UOM}}

Kindly review replenishment before production or sales are affected.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'LOW_STOCK' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Reorder: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the item below has reached its reorder point.

The particulars are as follows:

• Item: {{ITEM_NAME}} ({{ITEM_CODE}})
• Quantity available: {{AVAILABLE_QTY}} {{UOM}}
• Reorder point: {{REORDER_POINT}} {{UOM}}

Kindly raise a purchase request so that supply may be restored.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'STOCK_REORDER' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Production order released: {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} has been released for manufacture.

The particulars are as follows:

• Product: {{PRODUCT_NAME}}
• Quantity: {{QUANTITY}} {{UOM}}
• Scheduled start: {{START_DATE}}
• Machine: {{MACHINE_NAME}}

Kindly confirm that materials and the machine will be available at the scheduled start.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_ORDER_RELEASED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Production order completed: {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} has been completed.

The particulars are as follows:

• Product: {{PRODUCT_NAME}}
• Good output: {{GOOD_QTY}} {{UOM}}
• Waste: {{WASTE_QTY}} {{UOM}}

Kindly review the result and close any outstanding quality or inventory matters.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_COMPLETED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Production delay: order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} is behind schedule and requires review.

The particulars are as follows:

• Delay: {{DELAY_MINUTES}} minutes
• Progress: {{PROGRESS_PERCENT}}%

Kindly establish the cause and advise whether the plan should be revised.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_DELAYED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Shift summary: {{SHIFT_NAME}}, {{SHIFT_DATE}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please find the production summary for the {{SHIFT_NAME}} shift of {{SHIFT_DATE}}.

The particulars are as follows:

• Output: {{OUTPUT_QTY}} {{UOM}}
• Target: {{TARGET_QTY}} {{UOM}}
• Achievement: {{ACHIEVEMENT_PERCENT}}%
• Waste: {{WASTE_PERCENT}}%

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'SHIFT_SUMMARY' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Machine breakdown: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that a breakdown has been reported. Production may be affected.

The particulars are as follows:

• Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
• Downtime to date: {{DOWNTIME_MINUTES}} minutes
• Order affected: {{ORDER_NO}}

Kindly arrange attendance and keep the affected order updated until the machine is returned to service.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MACHINE_BREAKDOWN' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Maintenance due: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that scheduled maintenance is due for the machine named below.

The particulars are as follows:

• Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
• Due date: {{DUE_DATE}}

Kindly book the maintenance window and confirm that production can be covered while the machine is stopped.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MAINTENANCE_DUE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Material shortage: order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} does not hold sufficient material to proceed as planned.

The particulars are as follows:

• Material: {{MATERIAL_NAME}}
• Quantity required: {{REQUIRED_QTY}} {{UOM}}
• Quantity available: {{AVAILABLE_QTY}} {{UOM}}
• Action required by: {{DEADLINE}}

Kindly arrange supply, or revise the order, before the deadline.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MATERIAL_SHORTAGE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Work order overdue: {{WORK_ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the work order below has passed its due date.

The particulars are as follows:

• Work order: {{WORK_ORDER_NO}}
• Product: {{PRODUCT_NAME}}
• Due date: {{DUE_DATE}}
• Status: {{STATUS}}

Kindly update the order with a revised completion date, or with the reason it remains open.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WORK_ORDER_OVERDUE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Asset overdue: {{ASSET_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the asset below was not returned on the expected date.

The particulars are as follows:

• Asset: {{ASSET_NO}} ({{ASSET_NAME}})
• Custodian: {{CUSTODIAN_NAME}}
• Expected return: {{EXPECTED_RETURN_DATE}}

Kindly confirm the present location of the asset and arrange its return, or record an approved extension.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CUSTODY_OVERDUE' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Inspection required: batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the batch below is ready for inspection. It should not proceed until it has been cleared.

The particulars are as follows:

• Batch: {{BATCH_NO}}
• Product: {{PRODUCT_NAME}}
• Inspection: {{INSPECTION_TYPE}}
• Location: {{INSPECTION_POINT}}
• To be completed by: {{DEADLINE}}

Kindly complete the inspection and record the result before the deadline.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_INSPECTION_REQUEST' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Quality hold: batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the batch below has been placed on quality hold. It must neither be used nor dispatched.

The particulars are as follows:

• Batch: {{BATCH_NO}}
• Product: {{PRODUCT_NAME}}
• Quantity blocked: {{QUANTITY}} {{UOM}}
• Reason: {{REASON}}

Kindly keep the quantity segregated until quality either releases it or rejects it.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_HOLD' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Batch rejected: {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the batch below has failed inspection.

The particulars are as follows:

• Batch: {{BATCH_NO}}
• Product: {{PRODUCT_NAME}}
• Quantity rejected: {{QUANTITY}} {{UOM}}
• Disposition: {{DISPOSITION}}

Kindly give effect to the disposition stated, and keep the rejected quantity out of usable stock.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_REJECTED' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Your HOPE DESIGN verification code',
  body = $hdmail$Hello {{RECIPIENT_NAME}},

Please use the verification code below to {{PURPOSE}}.

{{CODE}}

The particulars are as follows:

• This code expires in {{TTL_MINUTES}} minutes.
• It may be used once only.
• Do not disclose it to any person, including members of staff.

If you did not request this code, you may disregard this message. Please do not forward it.

Yours faithfully,
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

Yours faithfully,
{{sender_name}}
{{sender_title}}
HOPE DESIGN GROUP LTD$hdmail$
WHERE code = 'MAIL-INTERNAL-MEMO' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Meeting: {{meeting_title}}',
  body = $hdmail$Dear {{recipient_name}},

You are invited to attend the meeting set out below. Kindly confirm whether you will be present.

The particulars are as follows:

• Meeting: {{meeting_title}}
• Date: {{meeting_date}}
• Time: {{meeting_time}}
• Venue: {{meeting_venue}}

Agenda:
{{agenda}}

Yours faithfully,
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
  subject = 'Secure job {{job_number}}',
  body = $hdmail$Dear {{recipient_name}},

This letter acknowledges receipt and control of the secure print job named below.

The particulars are as follows:

• Job number: {{job_number}}
• Product: {{product_name}}
• Quantity: {{quantity}}
• Classification: {{classification}}
• Custody holder: {{custodian}}

This correspondence is controlled. It must not be forwarded, copied, or discussed outside the named custody chain.

Yours faithfully,
HOPE DESIGN GROUP LTD$hdmail$
WHERE code = 'MAIL-SECURITY-ACK' AND scope = 'SYSTEM';

UPDATE email_templates SET
  subject = 'Service request {{ticket_number}}',
  body = $hdmail$Dear {{requester_name}},

Your request has been registered with the HOPE DESIGN Service Desk. Kindly quote the ticket number in any further correspondence.

The particulars are as follows:

• Ticket: {{ticket_number}}
• Subject: {{ticket_subject}}
• Priority: {{priority}}
• Registered: {{logged_at}}

We shall write to you as the request progresses.

Yours faithfully,
HOPE DESIGN Service Desk$hdmail$
WHERE code = 'MAIL-TICKET-ACK' AND scope = 'SYSTEM';

-- ----------------------------------------------------- notification email

UPDATE notification_templates SET
  subject = 'Approval required: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

A document has been submitted for your approval.

The particulars are as follows:

• Document: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}
• Amount: {{AMOUNT}}
• Submitted by: {{REQUESTED_BY}}

Kindly review and determine the request at the following address:
{{APPROVAL_LINK}}

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'APPROVAL_REQUIRED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Approval escalated: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

An approval has stood since {{SUBMITTED_AT}} and is now escalated for the attention of management.

The particulars are as follows:

• Document: {{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}

Kindly review and determine the request at the following address:
{{APPROVAL_LINK}}

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'APPROVAL_ESCALATED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Inspection due: {{ASSET_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that an asset is due for inspection.

The particulars are as follows:

• Asset: {{ASSET_NAME}} ({{ASSET_NO}})
• Due date: {{DUE_DATE}}

Kindly arrange the inspection and record the result.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'ASSET_INSPECTION_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Maintenance due: {{ASSET_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that scheduled maintenance is due for the asset named below.

The particulars are as follows:

• Asset: {{ASSET_NAME}} ({{ASSET_NO}})
• Due date: {{DUE_DATE}}

Kindly book the maintenance window before the due date.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'ASSET_MAINTENANCE_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Contract expiring: {{EMPLOYEE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that a contract of employment is approaching expiry and requires a decision on renewal.

The particulars are as follows:

• Employee: {{EMPLOYEE_NAME}}
• Contract type: {{CONTRACT_TYPE}}
• Expiry date: {{EXPIRY_DATE}}
• Days remaining: {{DAYS_REMAINING}}

Kindly coordinate the renewal with the employee and with human resources.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CONTRACT_EXPIRY' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Asset overdue: {{ASSET_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the asset below was not returned on the expected date.

The particulars are as follows:

• Asset: {{ASSET_NO}} ({{ASSET_NAME}})
• Expected return: {{EXPECTED_RETURN_DATE}}

Kindly confirm the present location of the asset and arrange its return, or record an approved extension.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'CUSTODY_OVERDUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Delivery dispatched: {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{CUSTOMER_NAME}},

We write to advise that delivery {{DOCUMENT_NUMBER}} has been dispatched.

The particulars are as follows:

• Expected date: {{DELIVERY_DATE}}

Kindly contact us should the delivery not arrive as advised.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DELIVERY_DISPATCHED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Document expiring: {{DOC_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that a controlled document is approaching expiry.

The particulars are as follows:

• Document: {{DOC_NO}}
• Title: {{TITLE}}
• Expires: {{EXPIRES_AT}}

Kindly review the document and arrange its renewal or its withdrawal before it expires.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DOCUMENT_EXPIRY' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Document filed: {{DOCUMENT_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that a document has been filed on a record you follow.

The particulars are as follows:

• Document: {{DOCUMENT_NAME}}
• Record: {{ENTITY_TYPE}} {{ENTITY_CODE}}
• Filed by: {{UPLOADED_BY}}

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'DOCUMENT_UPLOADED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Stock without movement: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the item below has recorded no stock movement for an extended period and requires review.

The particulars are as follows:

• Item: {{ITEM_NAME}} ({{ITEM_CODE}})
• Quantity on hand: {{ON_HAND}}
• Days without movement: {{DAYS}}

Kindly confirm whether the quantity should be retained, transferred, or written down.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'INVENTORY_DEAD_STOCK' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Low stock: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the item below has fallen beneath its safety level.

The particulars are as follows:

• Item: {{ITEM_NAME}} ({{ITEM_CODE}})
• Quantity available: {{AVAILABLE_QTY}} {{UOM}}
• Safety stock: {{SAFETY_STOCK}} {{UOM}}

Kindly review replenishment before production or sales are affected.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'LOW_STOCK' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Machine breakdown: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that a breakdown has been reported. Production may be affected.

The particulars are as follows:

• Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
• Downtime to date: {{DOWNTIME_MINUTES}} minutes

Kindly arrange attendance and keep the affected work updated until the machine is returned to service.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MACHINE_BREAKDOWN' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Maintenance due: {{MACHINE_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that scheduled maintenance is due for the machine named below.

The particulars are as follows:

• Machine: {{MACHINE_NAME}} ({{MACHINE_CODE}})
• Due date: {{DUE_DATE}}

Kindly book the maintenance window and confirm that production can be covered while the machine is stopped.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MAINTENANCE_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Material shortage: order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} does not hold sufficient material to proceed as planned.

The particulars are as follows:

• Material: {{MATERIAL_NAME}}
• Quantity required: {{REQUIRED_QTY}} {{UOM}}
• Quantity available: {{AVAILABLE_QTY}} {{UOM}}

Kindly arrange supply, or revise the order.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'MATERIAL_SHORTAGE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Password change required: {{EMAIL}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that a user account requires a change of password.

The particulars are as follows:

• Name: {{DISPLAY_NAME}}
• Email: {{EMAIL}}
• Days since the last change: {{DAYS}}

Kindly ask the user to set a new password, or reset it should the user be unable to sign in.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PASSWORD_EXPIRY' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Payment outstanding: {{PAY_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that an approved payment has not been released within the expected time.

The particulars are as follows:

• Payment: {{PAY_NO}}
• Payee: {{PAYEE}}
• Amount: {{AMOUNT}} {{CURRENCY}}
• Days since approval: {{DAYS}}

Kindly arrange payment, or record the reason the payment is being held.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_DUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Payment received: {{DOCUMENT_NUMBER}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

We confirm that a payment has been received and posted to the account.

The particulars are as follows:

• Document: {{DOCUMENT_NUMBER}}
• Amount: {{AMOUNT}}
• Date posted: {{PAYMENT_DATE}}

No further action is required in respect of this receipt.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PAYMENT_RECEIVED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Production order completed: {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} has been completed.

The particulars are as follows:

• Good output: {{GOOD_QTY}} {{UOM}}

Kindly review the result and close any outstanding quality or inventory matters.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_COMPLETED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Production delay: order {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} is behind schedule and requires review.

The particulars are as follows:

• Delay: {{DELAY_MINUTES}} minutes
• Progress: {{PROGRESS_PERCENT}}%

Kindly establish the cause and advise whether the plan should be revised.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_DELAYED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Production order released: {{ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that production order {{ORDER_NO}} has been released for manufacture.

The particulars are as follows:

• Product: {{PRODUCT_NAME}}
• Quantity: {{QUANTITY}} {{UOM}}

Kindly confirm that materials and the machine will be available.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'PRODUCTION_ORDER_RELEASED' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Quality hold: batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the batch below has been placed on quality hold. It must neither be used nor dispatched.

The particulars are as follows:

• Batch: {{BATCH_NO}}
• Product: {{PRODUCT_NAME}}
• Quantity blocked: {{QUANTITY}} {{UOM}}
• Reason: {{REASON}}

Kindly keep the quantity segregated until quality either releases it or rejects it.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_HOLD' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Inspection awaiting review: {{INSPECTION_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that a quality inspection is awaiting review.

The particulars are as follows:

• Inspection: {{INSPECTION_NO}}
• Type: {{KIND}}
• Product: {{PRODUCT_NAME}}
• Batch: {{BATCH_NO}}

Kindly complete the review and record the decision.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_INSPECTION_PENDING' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Inspection required: batch {{BATCH_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the batch below is ready for inspection. It should not proceed until it has been cleared.

The particulars are as follows:

• Batch: {{BATCH_NO}}
• Product: {{PRODUCT_NAME}}
• Inspection: {{INSPECTION_TYPE}}
• Location: {{INSPECTION_POINT}}

Kindly complete the inspection and record the result.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUALITY_INSPECTION_REQUEST' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Quarantine review: {{PRODUCT_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that stock has remained in quarantine longer than expected and now requires a decision.

The particulars are as follows:

• Product: {{PRODUCT_NAME}}
• Quantity: {{QUANTITY}}
• Days in quarantine: {{DAYS}}
• Reason: {{REASON}}

Kindly release the stock, reject it, or record a further hold.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'QUARANTINE_AGING' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Reorder: {{ITEM_NAME}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the item below has reached its reorder point.

The particulars are as follows:

• Item: {{ITEM_NAME}} ({{ITEM_CODE}})
• Quantity available: {{AVAILABLE_QTY}} {{UOM}}
• Reorder point: {{REORDER_POINT}} {{UOM}}

Kindly raise a purchase request so that supply may be restored.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'STOCK_REORDER' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Work order overdue: {{WORK_ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the work order below has passed its due date.

The particulars are as follows:

• Work order: {{WORK_ORDER_NO}}
• Product: {{PRODUCT_NAME}}
• Due date: {{DUE_DATE}}

Kindly update the order with a revised completion date, or with the reason it remains open.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WORK_ORDER_OVERDUE' AND channel = 'EMAIL';

UPDATE notification_templates SET
  subject = 'Work order inactive: {{WORK_ORDER_NO}}',
  body = $hdmail$Dear {{RECIPIENT_NAME}},

Please be advised that the work order below has not been updated within the expected time.

The particulars are as follows:

• Work order: {{WORK_ORDER_NO}}
• Product: {{PRODUCT_NAME}}
• Hours since the last update: {{STALE_HOURS}}

Kindly review the order and record its present status.

Yours faithfully,
{{COMPANY_NAME}}$hdmail$
WHERE code = 'WORK_ORDER_STALE' AND channel = 'EMAIL';
