UPDATE statutory_configs
SET name = 'Uganda PAYE (FY2026/27)',
    description = 'Monthly PAYE under the Income Tax (Amendment) Act 2026 (in force 2026-07-01): 0% up to 335,000; 20% on 335,001-410,000; 25% on 410,001-485,000; 30% on 485,001-10,000,000; 40% above 10,000,000. Employee NSSF is deducted from taxable pay before PAYE.',
    rates = '[{"max":335000,"min":0,"rate":0},{"max":410000,"min":335000,"rate":20},{"max":485000,"min":410000,"rate":25},{"max":10000000,"min":485000,"rate":30},{"max":null,"min":10000000,"rate":40}]'::jsonb
WHERE id = 2 AND code = 'UG-PAYE-2026'
RETURNING id, code, name, rates;