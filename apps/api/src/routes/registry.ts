import { Application, Router } from 'express';
import { crudRouter, CrudConfig } from './crudFactory.js';
import { submitQuotation, submitSalesOrder } from '../services/sales.js';
import { submitSupplier, submitRequisition, submitPurchaseOrder, submitSupplierInvoice, submitSupplierPayment } from '../services/procurement.js';
import { submitProductionPlan, submitWorkOrder } from '../services/production.js';

type Handlers = Pick<CrudConfig, 'submit' | 'afterCreate'>;

export const ENTITIES: (CrudConfig & Handlers)[] = [
  // ------------------------------------------------ CRM
  { table: 'customers', module: 'crm', resource: 'customers', label: 'Customer', codeColumn: 'code', codePrefix: 'CUST', statusColumn: 'status', searchable: ['name', 'email', 'phone', 'tin', 'code'], defaultOrder: 't.id DESC', qrEntityType: 'CUSTOMER' },
  { table: 'contacts', module: 'crm', resource: 'contacts', label: 'Contact', searchable: ['first_name', 'last_name', 'email', 'phone'], defaultOrder: 't.id DESC' },
  { table: 'leads', module: 'crm', resource: 'leads', label: 'Lead', codeColumn: 'lead_no', statusColumn: 'status', searchable: ['first_name', 'last_name', 'company_name', 'email', 'phone'], defaultOrder: 't.id DESC' },
  { table: 'opportunities', module: 'crm', resource: 'opportunities', label: 'Opportunity', statusColumn: 'stage', searchable: ['name'], defaultOrder: 't.id DESC' },
  { table: 'activities', module: 'crm', resource: 'activities', label: 'Activity', statusColumn: 'status', searchable: ['subject'], defaultOrder: 't.id DESC' },
  { table: 'complaints', module: 'crm', resource: 'complaints', label: 'Complaint', codeColumn: 'complaint_no', statusColumn: 'status', searchable: ['subject', 'complaint_no'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Sales
  { table: 'sales_quotations', module: 'sales', resource: 'quotations', label: 'Quotation', entityType: 'sales.quotations', codeColumn: 'quotation_no', codePrefix: 'QT', statusColumn: 'status', searchable: ['quotation_no'], defaultOrder: 't.id DESC', submit: submitQuotation },
  { table: 'sales_orders', module: 'sales', resource: 'orders', label: 'Sales Order', entityType: 'sales.orders', codeColumn: 'order_no', codePrefix: 'SO', statusColumn: 'status', searchable: ['order_no', 'customer_po_no'], defaultOrder: 't.id DESC', submit: submitSalesOrder, transitions: { cancel: 'CANCELLED' } },
  { table: 'delivery_notes', module: 'sales', resource: 'delivery_notes', label: 'Delivery Note', codeColumn: 'delivery_no', codePrefix: 'DN', statusColumn: 'status', searchable: ['delivery_no'], defaultOrder: 't.id DESC' },
  { table: 'customer_invoices', module: 'sales', resource: 'invoices', label: 'Invoice', entityType: 'sales.invoices', codeColumn: 'invoice_no', codePrefix: 'INV', statusColumn: 'status', searchable: ['invoice_no'], defaultOrder: 't.id DESC', transitions: { void: 'VOID' } },
  { table: 'receipts', module: 'sales', resource: 'receipts', label: 'Receipt', codeColumn: 'receipt_no', codePrefix: 'RCT', statusColumn: 'status', searchable: ['receipt_no'], defaultOrder: 't.id DESC', transitions: { void: 'VOID' } },
  { table: 'credit_notes', module: 'sales', resource: 'credit_notes', label: 'Credit Note', entityType: 'sales.credit_notes', codeColumn: 'credit_no', codePrefix: 'CN', statusColumn: 'status', searchable: ['credit_no'], defaultOrder: 't.id DESC', transitions: { void: 'VOID' } },
  { table: 'debit_notes', module: 'sales', resource: 'debit_notes', label: 'Debit Note', entityType: 'sales.debit_notes', codeColumn: 'debit_no', codePrefix: 'DNM', statusColumn: 'status', searchable: ['debit_no'], defaultOrder: 't.id DESC', transitions: { void: 'VOID' } },
  { table: 'sales_returns', module: 'sales', resource: 'returns', label: 'Sales Return', codeColumn: 'return_no', codePrefix: 'RET', statusColumn: 'status', searchable: ['return_no'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Procurement
  { table: 'suppliers', module: 'procurement', resource: 'suppliers', label: 'Supplier', entityType: 'procurement.suppliers', codeColumn: 'code', statusColumn: 'status', searchable: ['name', 'email', 'phone', 'tin', 'code'], defaultOrder: 't.id DESC', submit: submitSupplier },
  { table: 'supplier_contacts', module: 'procurement', resource: 'suppliers', label: 'Supplier Contact', searchable: ['first_name', 'last_name', 'email'], defaultOrder: 't.id DESC' },
  { table: 'supplier_contracts', module: 'procurement', resource: 'contracts', label: 'Supplier Contract', codeColumn: 'contract_no', statusColumn: 'status', searchable: ['contract_no'], defaultOrder: 't.id DESC' },
  { table: 'purchase_requisitions', module: 'procurement', resource: 'requisitions', label: 'Purchase Requisition', entityType: 'procurement.requisitions', codeColumn: 'pr_no', statusColumn: 'status', searchable: ['pr_no'], defaultOrder: 't.id DESC', submit: submitRequisition },
  { table: 'rfqs', module: 'procurement', resource: 'rfqs', label: 'RFQ', codeColumn: 'rfq_no', statusColumn: 'status', searchable: ['rfq_no'], defaultOrder: 't.id DESC' },
  { table: 'supplier_quotations', module: 'procurement', resource: 'quotations', label: 'Supplier Quotation', codeColumn: 'quote_no', statusColumn: 'status', searchable: ['quote_no'], defaultOrder: 't.id DESC' },
  { table: 'purchase_orders', module: 'procurement', resource: 'orders', label: 'Purchase Order', entityType: 'procurement.orders', codeColumn: 'po_no', statusColumn: 'status', searchable: ['po_no'], defaultOrder: 't.id DESC', submit: submitPurchaseOrder, transitions: { cancel: 'CANCELLED' } },
  { table: 'goods_receipts', module: 'procurement', resource: 'goods_receipts', label: 'Goods Receipt', codeColumn: 'grn_no', statusColumn: 'status', searchable: ['grn_no', 'delivery_ref'], defaultOrder: 't.id DESC' },
  { table: 'supplier_invoices', module: 'procurement', resource: 'supplier_invoices', label: 'Supplier Invoice', entityType: 'procurement.supplier_invoices', codeColumn: 'supplier_invoice_no', statusColumn: 'status', searchable: ['supplier_invoice_no'], defaultOrder: 't.id DESC', submit: submitSupplierInvoice, transitions: { void: 'VOID' } },
  { table: 'supplier_payments', module: 'procurement', resource: 'payments', label: 'Supplier Payment', entityType: 'procurement.payments', codeColumn: 'payment_no', statusColumn: 'status', searchable: ['payment_no'], defaultOrder: 't.id DESC', submit: submitSupplierPayment, transitions: { void: 'VOID' } },
  { table: 'purchase_returns', module: 'procurement', resource: 'returns', label: 'Purchase Return', codeColumn: 'return_no', statusColumn: 'status', searchable: ['return_no'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Inventory
  { table: 'products', module: 'inventory', resource: 'items', label: 'Product', codeColumn: 'code', codePrefix: 'PRD', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id DESC', qrEntityType: 'PRODUCT' },
  { table: 'products', module: 'inventory', resource: 'materials', label: 'Raw Material', codeColumn: 'code', codePrefix: 'RMW', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id DESC', qrEntityType: 'RAW_MATERIAL', permResource: 'items', filter: { column: 'type', values: ['JUMBO_ROLL', 'PAPER_BOBBIN', 'PACKAGING', 'CONSUMABLE', 'SPARE_PART'] }, defaults: { type: 'JUMBO_ROLL' } },
  { table: 'product_batches', module: 'inventory', resource: 'batches', label: 'Batch', codeColumn: 'batch_no', codePrefix: 'BT', statusColumn: 'status', searchable: ['batch_no', 'lot_no'], defaultOrder: 't.id DESC', qrEntityType: 'BATCH', listSelect: 't.*, COALESCE((SELECT SUM(i.quantity) FROM inventory i WHERE i.batch_id = t.id), 0) AS quantity' },
  { table: 'product_categories', module: 'inventory', resource: 'items', label: 'Product Category', searchable: ['name'], defaultOrder: 't.id DESC' },
  { table: 'units', module: 'inventory', resource: 'items', label: 'Unit', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },
  { table: 'warehouses', module: 'inventory', resource: 'warehouses', label: 'Warehouse', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },
  { table: 'warehouse_zones', module: 'inventory', resource: 'bins', label: 'Zone', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },
  { table: 'warehouse_racks', module: 'inventory', resource: 'bins', label: 'Rack', searchable: ['code'], defaultOrder: 't.id ASC' },
  { table: 'warehouse_shelves', module: 'inventory', resource: 'bins', label: 'Shelf', searchable: ['code'], defaultOrder: 't.id ASC' },
  { table: 'warehouse_bins', module: 'inventory', resource: 'bins', label: 'Bin', codeColumn: 'code', searchable: ['code'], defaultOrder: 't.id ASC', qrEntityType: 'BIN' },
  { table: 'inventory', module: 'inventory', resource: 'stock', label: 'Stock', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'inventory_movements', module: 'inventory', resource: 'movements', label: 'Stock Movement', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'inventory_reservations', module: 'inventory', resource: 'reservations', label: 'Reservation', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'inventory_adjustments', module: 'inventory', resource: 'adjustments', label: 'Stock Adjustment', entityType: 'inventory.adjustments', codeColumn: 'adjustment_no', statusColumn: 'status', searchable: ['adjustment_no'], defaultOrder: 't.id DESC' },
  { table: 'inventory_transfers', module: 'inventory', resource: 'transfers', label: 'Stock Transfer', entityType: 'inventory.transfers', codeColumn: 'transfer_no', statusColumn: 'status', searchable: ['transfer_no'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Production
  { table: 'production_plans', module: 'production', resource: 'plans', label: 'Production Plan', entityType: 'production.plans', codeColumn: 'plan_no', statusColumn: 'status', searchable: ['plan_no'], defaultOrder: 't.id DESC', submit: submitProductionPlan },
  { table: 'work_orders', module: 'production', resource: 'work_orders', label: 'Work Order', entityType: 'production.work_orders', codeColumn: 'wo_no', statusColumn: 'status', searchable: ['wo_no'], defaultOrder: 't.id DESC', submit: submitWorkOrder, qrEntityType: 'WORK_ORDER' },
  { table: 'boms', module: 'production', resource: 'boms', label: 'BOM', entityType: 'production.boms', codeColumn: 'bom_no', statusColumn: 'status', searchable: ['bom_no'], defaultOrder: 't.id DESC' },
  { table: 'bom_items', module: 'production', resource: 'boms', label: 'BOM Item', searchable: [], defaultOrder: 't.id ASC' },
  { table: 'routings', module: 'production', resource: 'routings', label: 'Routing', entityType: 'production.boms', codeColumn: 'routing_no', statusColumn: 'status', searchable: ['routing_no'], defaultOrder: 't.id DESC' },
  { table: 'routing_operations', module: 'production', resource: 'routings', label: 'Routing Operation', searchable: [], defaultOrder: 't.seq ASC' },
  { table: 'work_centres', module: 'production', resource: 'work_centres', label: 'Work Centre', codeColumn: 'code', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },
  { table: 'machines', module: 'production', resource: 'machines', label: 'Machine', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id ASC', qrEntityType: 'MACHINE' },
  { table: 'production_outputs', module: 'production', resource: 'outputs', label: 'Production Output', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'production_downtime', module: 'production', resource: 'downtime', label: 'Downtime', searchable: [], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Quality
  { table: 'inspection_plans', module: 'quality', resource: 'plans', label: 'Inspection Plan', codeColumn: 'plan_no', statusColumn: 'status', searchable: ['plan_no'], defaultOrder: 't.id DESC' },
  { table: 'inspections', module: 'quality', resource: 'inspections', label: 'Inspection', codeColumn: 'inspection_no', statusColumn: 'status', searchable: ['inspection_no'], defaultOrder: 't.id DESC' },
  { table: 'defects', module: 'quality', resource: 'defects', label: 'Defect', searchable: ['code', 'description'], defaultOrder: 't.id DESC' },
  { table: 'ncrs', module: 'quality', resource: 'ncrs', label: 'NCR', codeColumn: 'ncr_no', statusColumn: 'status', searchable: ['ncr_no'], defaultOrder: 't.id DESC' },
  { table: 'capa', module: 'quality', resource: 'capa', label: 'CAPA', codeColumn: 'capa_no', statusColumn: 'status', searchable: ['capa_no'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Maintenance
  { table: 'maintenance_requests', module: 'maintenance', resource: 'requests', label: 'Maintenance Request', codeColumn: 'request_no', statusColumn: 'status', searchable: ['request_no'], defaultOrder: 't.id DESC' },
  { table: 'maintenance_schedules', module: 'maintenance', resource: 'schedules', label: 'Maintenance Schedule', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'maintenance_work_orders', module: 'maintenance', resource: 'work_orders', label: 'Maintenance Work Order', codeColumn: 'mwo_no', statusColumn: 'status', searchable: ['mwo_no'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Logistics
  { table: 'vehicles', module: 'logistics', resource: 'vehicles', label: 'Vehicle', codeColumn: 'registration_no', statusColumn: 'status', searchable: ['registration_no', 'make', 'model'], defaultOrder: 't.id DESC' },
  { table: 'routes', module: 'logistics', resource: 'routes', label: 'Route', searchable: ['name'], defaultOrder: 't.id DESC' },
  { table: 'drivers', module: 'logistics', resource: 'drivers', label: 'Driver', searchable: ['first_name', 'last_name', 'phone'], defaultOrder: 't.id DESC' },
  { table: 'trips', module: 'logistics', resource: 'trips', label: 'Trip', codeColumn: 'trip_no', statusColumn: 'status', searchable: ['trip_no'], defaultOrder: 't.id DESC' },
  { table: 'fuel_logs', module: 'logistics', resource: 'fuel', label: 'Fuel Log', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'fleet_maintenance', module: 'logistics', resource: 'fleet', label: 'Fleet Maintenance', searchable: [], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Finance
  { table: 'chart_of_accounts', module: 'finance', resource: 'chart_of_accounts', label: 'Account', codeColumn: 'code', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'financial_periods', module: 'finance', resource: 'periods', label: 'Financial Period', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.start_date DESC' },
  { table: 'bank_accounts', module: 'finance', resource: 'banks', label: 'Bank Account', codeColumn: 'code', searchable: ['code', 'name', 'account_no'], defaultOrder: 't.id DESC' },
  { table: 'journal_entries', module: 'finance', resource: 'journals', label: 'Journal Entry', codeColumn: 'entry_no', statusColumn: 'status', searchable: ['entry_no', 'description'], defaultOrder: 't.id DESC' },
  { table: 'budgets', module: 'finance', resource: 'budgets', label: 'Budget', codeColumn: 'budget_no', statusColumn: 'status', searchable: ['budget_no'], defaultOrder: 't.id DESC' },
  { table: 'expenses', module: 'finance', resource: 'expenses', label: 'Expense', codeColumn: 'expense_no', statusColumn: 'status', searchable: ['expense_no'], defaultOrder: 't.id DESC' },
  { table: 'taxes', module: 'finance', resource: 'taxes', label: 'Tax', codeColumn: 'code', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },

  // ------------------------------------------------ HR
  { table: 'employees', module: 'hr', resource: 'employees', label: 'Employee', codeColumn: 'employee_no', statusColumn: 'status', searchable: ['employee_no', 'first_name', 'last_name', 'email'], defaultOrder: 't.id DESC' },
  { table: 'employment_contracts', module: 'hr', resource: 'contracts', label: 'Employment Contract', entityType: 'hr.contracts', codeColumn: 'contract_no', statusColumn: 'status', searchable: ['contract_no'], defaultOrder: 't.id DESC' },
  { table: 'attendance', module: 'hr', resource: 'attendance', label: 'Attendance', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'leave_requests', module: 'hr', resource: 'leave', label: 'Leave Request', codeColumn: 'leave_no', statusColumn: 'status', searchable: ['leave_no'], defaultOrder: 't.id DESC' },
  { table: 'payrolls', module: 'hr', resource: 'payrolls', label: 'Payroll', entityType: 'hr.payrolls', codeColumn: 'payroll_no', statusColumn: 'status', searchable: ['payroll_no'], defaultOrder: 't.id DESC' },
  { table: 'employee_loans', module: 'hr', resource: 'loans', label: 'Employee Loan', searchable: [], defaultOrder: 't.id DESC' },

  // Employee lifecycle records (Employee Management module)
  { table: 'employee_dependants', module: 'hr', resource: 'dependants', label: 'Dependant', permResource: 'employees', searchable: ['full_name'], defaultOrder: 't.id DESC' },
  { table: 'employee_emergency_contacts', module: 'hr', resource: 'emergency_contacts', label: 'Emergency Contact', permResource: 'employees', searchable: ['full_name', 'phone'], defaultOrder: 't.id DESC' },
  { table: 'employee_skills', module: 'hr', resource: 'skills', label: 'Employee Skill', permResource: 'employees', searchable: ['skill_name'], defaultOrder: 't.id DESC' },
  { table: 'employee_qualifications', module: 'hr', resource: 'qualifications', label: 'Qualification', permResource: 'employees', searchable: ['institution', 'qualification_name'], defaultOrder: 't.id DESC' },
  { table: 'employee_certifications', module: 'hr', resource: 'certifications', label: 'Certification', permResource: 'employees', searchable: ['name', 'cert_no'], defaultOrder: 't.id DESC' },
  { table: 'employee_work_history', module: 'hr', resource: 'work_history', label: 'Work History', permResource: 'employees', searchable: ['employer', 'job_title'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ HR / HCM (organisation builder)
  { table: 'divisions', module: 'hr', resource: 'divisions', label: 'Division', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'locations', module: 'hr', resource: 'locations', label: 'Location', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name', 'city', 'country'], defaultOrder: 't.code ASC' },
  { table: 'org_units', module: 'hr', resource: 'org_units', label: 'Organisation Unit', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'teams', module: 'hr', resource: 'teams', label: 'Team', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'job_families', module: 'hr', resource: 'job_families', label: 'Job Family', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'job_grades', module: 'hr', resource: 'job_grades', label: 'Job Grade', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.level ASC' },
  { table: 'positions', module: 'hr', resource: 'positions', label: 'Position', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'title'], defaultOrder: 't.code ASC' },
  { table: 'position_assignments', module: 'hr', resource: 'position_assignments', label: 'Position Assignment', searchable: [], defaultOrder: 't.id DESC' },

  // Workforce planning
  { table: 'workforce_plans', module: 'hr', resource: 'workforce_plans', label: 'Workforce Plan', entityType: 'hr.workforce_plans', codeColumn: 'plan_no', codePrefix: 'WFP', statusColumn: 'status', searchable: ['plan_no', 'plan_name'], defaultOrder: 't.id DESC' },
  { table: 'workforce_plan_lines', module: 'hr', resource: 'workforce_plans', label: 'Workforce Plan Line', searchable: [], defaultOrder: 't.id ASC' },
  { table: 'workforce_scenarios', module: 'hr', resource: 'workforce_scenarios', label: 'Workforce Scenario', codeColumn: 'scenario_no', codePrefix: 'WFSC', statusColumn: 'status', searchable: ['scenario_no', 'name'], defaultOrder: 't.id DESC' },

  // Recruitment / ATS
  { table: 'job_requisitions', module: 'hr', resource: 'requisitions', label: 'Job Requisition', entityType: 'hr.requisitions', codeColumn: 'requisition_no', codePrefix: 'REQ', statusColumn: 'status', searchable: ['requisition_no', 'title'], defaultOrder: 't.id DESC' },
  { table: 'vacancies', module: 'hr', resource: 'vacancies', label: 'Vacancy', codeColumn: 'vacancy_no', codePrefix: 'VAC', statusColumn: 'status', searchable: ['vacancy_no', 'title'], defaultOrder: 't.id DESC' },
  { table: 'vacancy_channels', module: 'hr', resource: 'vacancy_channels', label: 'Vacancy Channel', statusColumn: 'status', searchable: ['provider', 'url'], defaultOrder: 't.id DESC' },
  { table: 'candidates', module: 'hr', resource: 'candidates', label: 'Candidate', statusColumn: 'status', searchable: ['first_name', 'last_name', 'email', 'phone'], defaultOrder: 't.id DESC' },
  { table: 'candidate_applications', module: 'hr', resource: 'applications', label: 'Candidate Application', codeColumn: 'application_no', codePrefix: 'APP', statusColumn: 'status', searchable: ['application_no'], defaultOrder: 't.id DESC' },
  { table: 'interviews', module: 'hr', resource: 'interviews', label: 'Interview', codeColumn: 'interview_no', codePrefix: 'INT', statusColumn: 'status', searchable: ['interview_no'], defaultOrder: 't.scheduled_at DESC' },
  { table: 'assessments', module: 'hr', resource: 'assessments', label: 'Assessment', codeColumn: 'assessment_no', codePrefix: 'ASMT', statusColumn: 'status', searchable: ['assessment_no', 'type'], defaultOrder: 't.id DESC' },
  { table: 'job_offers', module: 'hr', resource: 'offers', label: 'Job Offer', codeColumn: 'offer_no', codePrefix: 'OFF', statusColumn: 'status', searchable: ['offer_no'], defaultOrder: 't.id DESC' },

  // Onboarding
  { table: 'onboarding_checklists', module: 'hr', resource: 'onboarding', label: 'Onboarding Checklist', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'onboarding_tasks', module: 'hr', resource: 'onboarding', label: 'Onboarding Task', codeColumn: 'task_no', statusColumn: 'status', searchable: ['task_no', 'title'], defaultOrder: 't.sort_order ASC' },
  { table: 'onboarding_instances', module: 'hr', resource: 'onboarding', label: 'Onboarding Instance', codeColumn: 'instance_no', codePrefix: 'ONB', statusColumn: 'status', searchable: ['instance_no'], defaultOrder: 't.id DESC' },
  { table: 'onboarding_instance_tasks', module: 'hr', resource: 'onboarding', label: 'Onboarding Instance Task', statusColumn: 'status', searchable: [], defaultOrder: 't.id ASC' },

  // Offboarding / exit clearance / alumni
  { table: 'offboarding_checklists', module: 'hr', resource: 'offboardings', label: 'Offboarding Checklist', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'offboarding_tasks', module: 'hr', resource: 'offboardings', label: 'Offboarding Task', codeColumn: 'task_no', statusColumn: 'status', searchable: ['task_no', 'title'], defaultOrder: 't.sort_order ASC' },
  { table: 'offboarding_instances', module: 'hr', resource: 'offboardings', label: 'Offboarding Instance', codeColumn: 'instance_no', codePrefix: 'OB', statusColumn: 'status', searchable: ['instance_no'], defaultOrder: 't.id DESC' },
  { table: 'offboarding_instance_tasks', module: 'hr', resource: 'offboardings', label: 'Offboarding Instance Task', statusColumn: 'status', searchable: [], defaultOrder: 't.id ASC' },

  // Employee movements + salary history (payroll change control)
  { table: 'employee_movements', module: 'hr', resource: 'employee_movements', label: 'Employee Movement', permResource: 'employees', statusColumn: 'status', searchable: [], defaultOrder: 't.effective_from DESC' },
  { table: 'salary_histories', module: 'hr', resource: 'salary_histories', label: 'Salary History', permResource: 'employees', searchable: [], defaultOrder: 't.effective_date DESC' },

  // Attendance / time
  { table: 'shifts', module: 'hr', resource: 'shifts', label: 'Shift', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'shift_assignments', module: 'hr', resource: 'shift_assignments', label: 'Shift Assignment', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'overtime_requests', module: 'hr', resource: 'overtime', label: 'Overtime Request', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'timesheets', module: 'hr', resource: 'timesheets', label: 'Timesheet', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'timesheet_lines', module: 'hr', resource: 'timesheets', label: 'Timesheet Line', searchable: [], defaultOrder: 't.work_date ASC' },

  // Leave
  { table: 'leave_types', module: 'hr', resource: 'leave_types', label: 'Leave Type', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'leave_policies', module: 'hr', resource: 'leave_policies', label: 'Leave Policy', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'leave_accrual_rules', module: 'hr', resource: 'leave_accruals', label: 'Leave Accrual Rule', searchable: [], defaultOrder: 't.id ASC' },
  { table: 'leave_balances', module: 'hr', resource: 'leave_balances', label: 'Leave Balance', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'holidays', module: 'hr', resource: 'holidays', label: 'Holiday', searchable: ['name'], defaultOrder: 't.holiday_date DESC' },

  // Performance
  { table: 'performance_goals', module: 'hr', resource: 'performance_goals', label: 'Performance Goal', statusColumn: 'status', searchable: ['title'], defaultOrder: 't.id DESC' },
  { table: 'performance_kpis', module: 'hr', resource: 'performance_kpis', label: 'Performance KPI', statusColumn: 'status', searchable: ['name'], defaultOrder: 't.id DESC' },
  { table: 'performance_reviews', module: 'hr', resource: 'performance_reviews', label: 'Performance Review', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'performance_review_items', module: 'hr', resource: 'performance_reviews', label: 'Review Item', searchable: [], defaultOrder: 't.id ASC' },
  { table: 'performance_review_feedback', module: 'hr', resource: 'performance_reviews', label: 'Review Feedback', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'performance_improvement_plans', module: 'hr', resource: 'pips', label: 'Performance Improvement Plan', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },

  // Learning & development
  { table: 'training_catalog', module: 'hr', resource: 'training_catalog', label: 'Training Course', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'title'], defaultOrder: 't.code ASC' },
  { table: 'training_sessions', module: 'hr', resource: 'training_sessions', label: 'Training Session', codeColumn: 'code', statusColumn: 'status', searchable: ['code'], defaultOrder: 't.start_date DESC' },
  { table: 'training_requests', module: 'hr', resource: 'training_requests', label: 'Training Request', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'training_enrollments', module: 'hr', resource: 'training_enrollments', label: 'Training Enrollment', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'training_certificates', module: 'hr', resource: 'training_certificates', label: 'Training Certificate', codeColumn: 'certificate_no', codePrefix: 'CERT', statusColumn: 'status', searchable: ['certificate_no'], defaultOrder: 't.id DESC' },
  { table: 'competencies', module: 'hr', resource: 'competencies', label: 'Competency', codeColumn: 'code', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'employee_competencies', module: 'hr', resource: 'competencies', label: 'Employee Competency', searchable: [], defaultOrder: 't.id DESC' },

  // Benefits
  { table: 'benefit_plans', module: 'hr', resource: 'benefit_plans', label: 'Benefit Plan', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'benefit_enrollments', module: 'hr', resource: 'benefit_enrollments', label: 'Benefit Enrollment', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'benefit_claims', module: 'hr', resource: 'benefit_claims', label: 'Benefit Claim', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },

  // Employee relations
  { table: 'grievances', module: 'hr', resource: 'grievances', label: 'Grievance', statusColumn: 'status', searchable: ['subject'], defaultOrder: 't.id DESC' },
  { table: 'investigations', module: 'hr', resource: 'investigations', label: 'Investigation', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'disciplinary_cases', module: 'hr', resource: 'disciplinary', label: 'Disciplinary Case', codeColumn: 'case_no', codePrefix: 'DC', statusColumn: 'status', searchable: ['case_no'], defaultOrder: 't.id DESC' },
  { table: 'disciplinary_actions', module: 'hr', resource: 'disciplinary', label: 'Disciplinary Action', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'warnings', module: 'hr', resource: 'warnings', label: 'Warning', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },

  // HR asset assignments
  { table: 'asset_assignments', module: 'hr', resource: 'asset_assignments', label: 'Asset Assignment', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },

  // Payroll configuration
  { table: 'payroll_component_definitions', module: 'hr', resource: 'payroll_components', label: 'Payroll Component', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC' },
  { table: 'employee_payroll_components', module: 'hr', resource: 'payroll_components', label: 'Employee Payroll Component', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'payroll_component_entries', module: 'hr', resource: 'payroll_components', label: 'Payroll Component Entry', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'employee_salaries', module: 'hr', resource: 'employee_salaries', label: 'Employee Salary', searchable: [], defaultOrder: 't.effective_from DESC' },
  { table: 'employee_earnings', module: 'hr', resource: 'employee_earnings', label: 'Employee Earning', statusColumn: 'status', searchable: [], defaultOrder: 't.effective_from DESC' },
  { table: 'employee_deductions', module: 'hr', resource: 'employee_deductions', label: 'Employee Deduction', statusColumn: 'status', searchable: [], defaultOrder: 't.effective_from DESC' },
  { table: 'employee_benefits', module: 'hr', resource: 'employee_benefits', label: 'Employee Benefit', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'overtime_records', module: 'hr', resource: 'overtime_records', label: 'Overtime Record', statusColumn: 'status', searchable: [], defaultOrder: 't.overtime_date DESC' },
  { table: 'bonus_records', module: 'hr', resource: 'bonus_records', label: 'Bonus Record', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'commission_records', module: 'hr', resource: 'commission_records', label: 'Commission Record', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'statutory_configs', module: 'hr', resource: 'statutory_configs', label: 'Statutory Config', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name', 'country', 'category'], defaultOrder: 't.effective_from DESC' },

  // Self-service + projects
  { table: 'employee_requests', module: 'hr', resource: 'employee_requests', label: 'Employee Request', statusColumn: 'status', searchable: ['subject'], defaultOrder: 't.id DESC' },
  { table: 'projects', module: 'hr', resource: 'projects', label: 'Project', codeColumn: 'code', codePrefix: 'PRJ', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.code ASC', listSelect: 't.*, COALESCE((SELECT u.first_name || \' \' || u.last_name FROM users u WHERE u.id = t.manager_user_id), \'\') AS manager_name' },

  // ------------------------------------------------ Assets
  { table: 'assets', module: 'assets', resource: 'register', label: 'Asset', codeColumn: 'asset_no', statusColumn: 'status', searchable: ['asset_no', 'name', 'serial_no'], defaultOrder: 't.id DESC', qrEntityType: 'ASSET' },
  { table: 'asset_categories', module: 'assets', resource: 'categories', label: 'Asset Category', searchable: ['name'], defaultOrder: 't.id ASC' },
  { table: 'asset_types', module: 'assets', resource: 'types', label: 'Asset Type', codeColumn: 'code', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },
  { table: 'asset_classes', module: 'assets', resource: 'classes', label: 'Asset Class', codeColumn: 'code', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },
  { table: 'asset_locations', module: 'assets', resource: 'locations', label: 'Asset Location', codeColumn: 'code', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },

  // ------------------------------------------------ Documents
  { table: 'documents', module: 'documents', resource: 'documents', label: 'Document', codeColumn: 'doc_no', statusColumn: 'status', searchable: ['doc_no', 'title', 'category'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Healthcare
  { table: 'care_facilities', module: 'healthcare', resource: 'facilities', label: 'Care Facility', codeColumn: 'code', codePrefix: 'FAC', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id DESC', qrEntityType: 'CARE_FACILITY' },
  { table: 'wards', module: 'healthcare', resource: 'wards', label: 'Ward', codeColumn: 'code', codePrefix: 'WARD', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id DESC', qrEntityType: 'WARD' },
  { table: 'beds', module: 'healthcare', resource: 'beds', label: 'Bed', codeColumn: 'code', codePrefix: 'BED', statusColumn: 'status', searchable: ['code'], defaultOrder: 't.id ASC', qrEntityType: 'BED' },
  { table: 'practitioners', module: 'healthcare', resource: 'practitioners', label: 'Practitioner', codeColumn: 'practitioner_no', statusColumn: 'status', searchable: ['practitioner_no', 'first_name', 'last_name', 'license_no'], defaultOrder: 't.id DESC', qrEntityType: 'PRACTITIONER' },
  { table: 'patients', module: 'healthcare', resource: 'patients', label: 'Patient', codeColumn: 'patient_no', statusColumn: 'status', searchable: ['patient_no', 'first_name', 'last_name', 'phone'], defaultOrder: 't.id DESC', qrEntityType: 'PATIENT' },
  { table: 'patient_visits', module: 'healthcare', resource: 'visits', label: 'Patient Visit', codeColumn: 'visit_no', statusColumn: 'status', searchable: ['visit_no', 'complaint'], defaultOrder: 't.id DESC' },
  { table: 'appointments', module: 'healthcare', resource: 'appointments', label: 'Appointment', codeColumn: 'appointment_no', statusColumn: 'status', searchable: ['appointment_no', 'reason'], defaultOrder: 't.scheduled_at DESC' },
  { table: 'electronic_medical_records', module: 'healthcare', resource: 'emrs', label: 'EMR', codeColumn: 'emr_no', statusColumn: 'status', searchable: ['emr_no', 'title'], defaultOrder: 't.clinical_date DESC' },
  { table: 'diagnoses', module: 'healthcare', resource: 'diagnoses', label: 'Diagnosis', statusColumn: 'status', searchable: ['icd_code', 'description'], defaultOrder: 't.id DESC' },
  { table: 'vitals', module: 'healthcare', resource: 'vitals', label: 'Vitals', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'nursing_observations', module: 'healthcare', resource: 'observations', label: 'Nursing Observation', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'prescriptions', module: 'healthcare', resource: 'prescriptions', label: 'Prescription', codeColumn: 'prescription_no', statusColumn: 'status', searchable: ['prescription_no'], defaultOrder: 't.id DESC' },
  { table: 'prescription_items', module: 'healthcare', resource: 'prescriptions', label: 'Prescription Item', searchable: [], defaultOrder: 't.id ASC' },
  { table: 'dispensings', module: 'healthcare', resource: 'dispensings', label: 'Dispensing', codeColumn: 'dispensing_no', statusColumn: 'status', searchable: ['dispensing_no'], defaultOrder: 't.id DESC' },
  { table: 'lab_requests', module: 'healthcare', resource: 'lab_requests', label: 'Lab Request', codeColumn: 'request_no', statusColumn: 'status', searchable: ['request_no', 'clinical_note'], defaultOrder: 't.id DESC' },
  { table: 'lab_request_tests', module: 'healthcare', resource: 'lab_requests', label: 'Lab Request Test', searchable: [], defaultOrder: 't.id ASC' },
  { table: 'lab_results', module: 'healthcare', resource: 'lab_results', label: 'Lab Result', codeColumn: 'result_no', statusColumn: 'status', searchable: ['result_no', 'test_name'], defaultOrder: 't.id DESC' },
  { table: 'insurance_payers', module: 'healthcare', resource: 'insurance_payers', label: 'Insurance Payer', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id DESC' },
  { table: 'insurance_claims', module: 'healthcare', resource: 'insurance_claims', label: 'Insurance Claim', codeColumn: 'claim_no', statusColumn: 'status', searchable: ['claim_no'], defaultOrder: 't.id DESC' },
  { table: 'healthcare_bills', module: 'healthcare', resource: 'bills', label: 'Healthcare Bill', codeColumn: 'bill_no', statusColumn: 'status', searchable: ['bill_no'], defaultOrder: 't.id DESC' },

  // ------------------------------------------------ Workflows / Notifications
  { table: 'workflows', module: 'workflows', resource: 'workflows', label: 'Workflow', codeColumn: 'code', statusColumn: 'status', searchable: ['code', 'name'], defaultOrder: 't.id ASC' },
  { table: 'workflow_instances', module: 'workflows', resource: 'instances', label: 'Workflow Instance', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'approval_tasks', module: 'workflows', resource: 'instances', label: 'Approval Task', statusColumn: 'status', searchable: [], defaultOrder: 't.id DESC' },
  { table: 'user_tasks', module: 'notifications', resource: 'tasks', label: 'Task', statusColumn: 'status', searchable: ['title'], defaultOrder: 't.id DESC' },
];

export function mountCrud(app: Application) {
  for (const cfg of ENTITIES) {
    const router: Router = crudRouter(cfg);
    app.use(`/api/${cfg.module}/${cfg.resource}`, router);
  }
}

export function entityForTable(table: string): CrudConfig | undefined {
  return ENTITIES.find((e) => e.table === table);
}
