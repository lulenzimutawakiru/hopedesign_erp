UPDATE statutory_configs
SET name = 'Uganda Local Service Tax (KCCA graduated monthly)',
    description = 'KCCA salaried-employee LST monthly deductions keyed on monthly gross pay (annual band / 4). Collected July-October each year; not deductible from taxable pay.',
    rates = '{}'::jsonb,
    limits = '{"apply_to_payroll":true,"months":[7,8,9,10],"bands":[{"max":100000,"monthly_amount":0},{"max":200000,"monthly_amount":1250},{"max":300000,"monthly_amount":2500},{"max":400000,"monthly_amount":5000},{"max":500000,"monthly_amount":7500},{"max":600000,"monthly_amount":10000},{"max":700000,"monthly_amount":15000},{"max":800000,"monthly_amount":17500},{"max":900000,"monthly_amount":20000},{"max":1000000,"monthly_amount":22500},{"max":null,"monthly_amount":25000}]}'::jsonb
WHERE id = 4 AND code = 'UG-LST-2023'
RETURNING id, code, name, rates, limits;