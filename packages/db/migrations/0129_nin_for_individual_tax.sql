-- 0129 NIN as the tax identifier for individuals
--
-- URA/NIRA direction: businesses identify themselves with a TIN while
-- individuals are identified by their National Identification Number (NIN)
-- for tax reporting (payroll/PAYE, EFRIS e-invoicing buyer and supplier
-- parties, withholding tax). Add an optional nin column beside tin on every
-- counterparty master so an individual record can carry a NIN and the fiscal
-- document layer can print "NIN ..." instead of "TIN ..." for them.
--
-- Nothing is backfilled: records that have no NIN yet keep printing their
-- legacy TIN until an individual NIN is captured.

ALTER TABLE customers ADD COLUMN nin TEXT;
COMMENT ON COLUMN customers.nin IS 'National Identification Number (URA tax identifier for individual customers)';

ALTER TABLE suppliers ADD COLUMN nin TEXT;
COMMENT ON COLUMN suppliers.nin IS 'National Identification Number (URA tax identifier for individual suppliers)';

ALTER TABLE employees ADD COLUMN nin TEXT;
COMMENT ON COLUMN employees.nin IS 'National Identification Number (URA tax identifier for employees)';
