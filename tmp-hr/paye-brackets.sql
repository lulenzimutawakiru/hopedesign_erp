UPDATE statutory_configs
SET name = 'Uganda PAYE (FY2026/27 amended)',
    rates = '[{"max":335000,"min":0,"rate":0},{"max":410000,"min":335000,"rate":10},{"max":485000,"min":410000,"rate":25},{"max":10000000,"min":485000,"rate":30},{"max":null,"min":10000000,"rate":40}]'::jsonb
WHERE id = 2
RETURNING id, code, name, rates;
