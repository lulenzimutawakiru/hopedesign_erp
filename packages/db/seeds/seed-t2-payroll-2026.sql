
BEGIN;
INSERT INTO employees (company_id, tenant_id, branch_id, department_id, employee_no, first_name, last_name, position, hire_date, base_salary, status, employment_type, attributes, created_at, updated_at) VALUES
(2, 2, 2, NULL, '1', 'Anthony', 'Njenga Chege', 'Oper. & flo. Supv.', '2025-06-02', 1849231, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2025-06-02', '2025-06-02'),
(2, 2, 2, NULL, '2', 'Guillaume', 'Niyonzima', 'Driver & G.S.', '2025-06-02', 1081923, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2025-06-02', '2025-06-02'),
(2, 2, 2, NULL, '3', 'Dinah Hannah', '.S.M.', 'CEO''s Assistant', '2025-06-02', 926154, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2025-06-02', '2025-06-02'),
(2, 2, 2, NULL, '4', 'Solomon', 'Munyagwa', 'Oper. Ass.', '2025-06-02', 607116, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2025-06-02', '2025-06-02'),
(2, 2, 2, 3, '5', 'Tabu', 'Derrick', 'Production', '2025-06-02', 369616, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2025-06-02', '2025-06-02'),
(2, 2, 2, 3, '6', 'Emile', 'Niyungeko', 'Production', '2026-08-12', 368846, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2026-08-12', '2026-08-12'),
(2, 2, 2, 3, '7', 'Gloria', 'Nakakawa', 'Production', '2026-08-12', 368846, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2026-08-12', '2026-08-12'),
(2, 2, 2, 3, '8', 'Racheal', 'Tagulwa', 'Production', '2026-08-12', 368846, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2026-08-12', '2026-08-12'),
(2, 2, 2, 3, '9', 'Lorraine', 'Ninihazwe', 'Production', '2026-08-12', 368846, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2026-08-12', '2026-08-12'),
(2, 2, 2, 3, '10', 'Shamirah', 'Nantume', 'Production', '2026-08-12', 368846, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2026-08-12', '2026-08-12'),
(2, 2, 2, 3, '11', 'Viola', 'Akatikwasa', 'Production', '2026-08-12', 368846, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2026-08-12', '2026-08-12'),
(2, 2, 2, NULL, '12', 'Mbeba David', 'Sebikali', 'Office Att.', '2025-06-02', 320789, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2025-06-02', '2025-06-02'),
(2, 2, 2, 1, '13', 'Nanette', 'Arakaza', 'Accountant', '2025-06-02', 926154, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2025-06-02', '2025-06-02'),
(2, 2, 2, 8, '14', 'Nyirinkindi', 'Annonciata', 'HR', '2026-08-01', 692885, 'ACTIVE', 'PERMANENT', '{}'::jsonb, '2026-08-01', '2026-08-01');
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, NULL, 'anthony.chege@hopedesign.co.ug', 'anthony.chege', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Anthony', 'Njenga Chege', 'Oper. & flo. Supv.', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, NULL, 'guillaume.niyonzima@hopedesign.co.ug', 'guillaume.niyonzima', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Guillaume', 'Niyonzima', 'Driver & G.S.', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, NULL, 'dinah.hannah@hopedesign.co.ug', 'dinah.hannah', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Dinah Hannah', '.S.M.', 'CEO''s Assistant', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, NULL, 'solomon.munyagwa@hopedesign.co.ug', 'solomon.munyagwa', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Solomon', 'Munyagwa', 'Oper. Ass.', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 3, 'tabu.derrick@hopedesign.co.ug', 'tabu.derrick', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Tabu', 'Derrick', 'Production', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 3, 'emile.niyungeko@hopedesign.co.ug', 'emile.niyungeko', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Emile', 'Niyungeko', 'Production', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 3, 'gloria.nakakawa@hopedesign.co.ug', 'gloria.nakakawa', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Gloria', 'Nakakawa', 'Production', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 3, 'racheal.tagulwa@hopedesign.co.ug', 'racheal.tagulwa', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Racheal', 'Tagulwa', 'Production', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 3, 'lorraine.ninihazwe@hopedesign.co.ug', 'lorraine.ninihazwe', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Lorraine', 'Ninihazwe', 'Production', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 3, 'shamirah.nantume@hopedesign.co.ug', 'shamirah.nantume', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Shamirah', 'Nantume', 'Production', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 3, 'viola.akatikwasa@hopedesign.co.ug', 'viola.akatikwasa', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Viola', 'Akatikwasa', 'Production', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, NULL, 'mbeba.sebikali@hopedesign.co.ug', 'mbeba.sebikali', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Mbeba David', 'Sebikali', 'Office Att.', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 1, 'nanette.arakaza@hopedesign.co.ug', 'nanette.arakaza', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Nanette', 'Arakaza', 'Accountant', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
INSERT INTO users
    (tenant_id, company_id, branch_id, department_id, email, username, password_hash, first_name, last_name, job_title, status, must_change_password, mfa_enabled, failed_attempts, attributes, settings)
    VALUES (2, 2, 2, 8, 'nyirinkindi.annonciata@hopedesign.co.ug', 'nyirinkindi.annonciata', '$2a$10$Avb0VDhAeXPrEfxKcnKTLOgBZJ/QpWPj8CB.1HSBhfOmWdklT8WZa', 'Nyirinkindi', 'Annonciata', 'HR', 'ACTIVE', true, false, 0, '{}'::jsonb, '{"theme":"light","locale":"en-UG"}'::jsonb);
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'anthony.chege@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1')
    WHERE tenant_id = 2 AND email = 'anthony.chege@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'anthony.chege@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'guillaume.niyonzima@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2')
    WHERE tenant_id = 2 AND email = 'guillaume.niyonzima@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'guillaume.niyonzima@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'dinah.hannah@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3')
    WHERE tenant_id = 2 AND email = 'dinah.hannah@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'dinah.hannah@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'solomon.munyagwa@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4')
    WHERE tenant_id = 2 AND email = 'solomon.munyagwa@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'solomon.munyagwa@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'tabu.derrick@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5')
    WHERE tenant_id = 2 AND email = 'tabu.derrick@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'tabu.derrick@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'emile.niyungeko@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6')
    WHERE tenant_id = 2 AND email = 'emile.niyungeko@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'emile.niyungeko@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'gloria.nakakawa@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7')
    WHERE tenant_id = 2 AND email = 'gloria.nakakawa@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'gloria.nakakawa@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'racheal.tagulwa@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8')
    WHERE tenant_id = 2 AND email = 'racheal.tagulwa@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'racheal.tagulwa@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'lorraine.ninihazwe@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9')
    WHERE tenant_id = 2 AND email = 'lorraine.ninihazwe@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'lorraine.ninihazwe@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'shamirah.nantume@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10')
    WHERE tenant_id = 2 AND email = 'shamirah.nantume@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'shamirah.nantume@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'viola.akatikwasa@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11')
    WHERE tenant_id = 2 AND email = 'viola.akatikwasa@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'viola.akatikwasa@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'mbeba.sebikali@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12')
    WHERE tenant_id = 2 AND email = 'mbeba.sebikali@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'mbeba.sebikali@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'nanette.arakaza@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13')
    WHERE tenant_id = 2 AND email = 'nanette.arakaza@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'nanette.arakaza@hopedesign.co.ug';
UPDATE employees SET user_id = (SELECT id FROM users WHERE tenant_id = 2 AND email = 'nyirinkindi.annonciata@hopedesign.co.ug')
    WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '14';
UPDATE users SET employee_id = (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '14')
    WHERE tenant_id = 2 AND email = 'nyirinkindi.annonciata@hopedesign.co.ug';
INSERT INTO user_roles (user_id, role_id, company_id, branch_id)
    SELECT id, 97, 2, 2 FROM users WHERE tenant_id = 2 AND email = 'nyirinkindi.annonciata@hopedesign.co.ug';
INSERT INTO payrolls
    (id, company_id, tenant_id, payroll_no, period_start, period_end, status, gross_total, deduction_total, net_total,
     created_by, currency, run_type, employee_ids, deduct_loans, deduct_advances, gl_posted, payment_date, created_at, updated_at, statutory_snapshot)
    VALUES (630, 2, 2, 'PAY-2026-00000044', '2026-06-01', '2026-06-30', 'PAID', 10660232, 4115651, 6544581,
     16, 'UGX', 'NORMAL', ARRAY[(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13')]::bigint[], true, true, false, '2026-06-30', '2026-06-30', '2026-06-30', '{"lst":{"code":"UG-LST-KCCA","name":"Uganda Local Service Tax - KCCA Kampala (monthly)","rates":{},"version":1,"category":"LST","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2023-06-30T21:00:00.000Z","effectiveTo":null,"limits":{"bands":[{"max":200000,"monthly_amount":1250},{"max":300000,"monthly_amount":2500},{"max":400000,"monthly_amount":5000},{"max":600000,"monthly_amount":10000},{"max":1000000,"monthly_amount":20000},{"max":null,"monthly_amount":25000}],"months":[7,8,9,10],"min_gross":100000,"apply_to_payroll":true}},"nssf":{"code":"UG-NSSF-2023","name":"Uganda NSSF (5% employee / 10% employer)","rates":{"employee":0.05,"employer":0.1},"version":1,"category":"NSSF","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2023-06-30T21:00:00.000Z","effectiveTo":null,"limits":{"monthly_ceiling":0}},"paye":{"code":"UG-PAYE-2026","name":"Uganda PAYE (current)","version":2,"category":"PAYE","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2026-06-30T21:00:00.000Z","effectiveTo":null,"limits":{},"rates":[{"min":0,"max":335000,"rate":0},{"min":335000,"max":410000,"rate":0.1},{"min":410000,"max":485000,"rate":0.25},{"min":485000,"max":10000000,"rate":0.3},{"min":10000000,"max":null,"rate":0.1}]}}'::jsonb);
INSERT INTO payrolls
    (id, company_id, tenant_id, payroll_no, period_start, period_end, status, gross_total, deduction_total, net_total,
     created_by, currency, run_type, employee_ids, deduct_loans, deduct_advances, gl_posted, payment_date, created_at, updated_at, statutory_snapshot)
    VALUES (631, 2, 2, 'PAY-2026-00000045', '2026-07-01', '2026-07-31', 'PAID', 6954971, 2298566, 4656405,
     16, 'UGX', 'NORMAL', ARRAY[(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13')]::bigint[], true, true, false, '2026-07-31', '2026-07-31', '2026-07-31', '{"lst":{"code":"UG-LST-KCCA","name":"Uganda Local Service Tax - KCCA Kampala (monthly)","rates":{},"version":1,"category":"LST","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2023-06-30T21:00:00.000Z","effectiveTo":null,"limits":{"bands":[{"max":200000,"monthly_amount":1250},{"max":300000,"monthly_amount":2500},{"max":400000,"monthly_amount":5000},{"max":600000,"monthly_amount":10000},{"max":1000000,"monthly_amount":20000},{"max":null,"monthly_amount":25000}],"months":[7,8,9,10],"min_gross":100000,"apply_to_payroll":true}},"nssf":{"code":"UG-NSSF-2023","name":"Uganda NSSF (5% employee / 10% employer)","rates":{"employee":0.05,"employer":0.1},"version":1,"category":"NSSF","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2023-06-30T21:00:00.000Z","effectiveTo":null,"limits":{"monthly_ceiling":0}},"paye":{"code":"UG-PAYE-2026","name":"Uganda PAYE (current)","version":2,"category":"PAYE","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2026-06-30T21:00:00.000Z","effectiveTo":null,"limits":{},"rates":[{"min":0,"max":335000,"rate":0},{"min":335000,"max":410000,"rate":0.1},{"min":410000,"max":485000,"rate":0.25},{"min":485000,"max":10000000,"rate":0.3},{"min":10000000,"max":null,"rate":0.1}]}}'::jsonb);
INSERT INTO payrolls
    (id, company_id, tenant_id, payroll_no, period_start, period_end, status, gross_total, deduction_total, net_total,
     created_by, currency, run_type, employee_ids, deduct_loans, deduct_advances, gl_posted, payment_date, created_at, updated_at, statutory_snapshot)
    VALUES (632, 2, 2, 'PAY-2026-00000046', '2026-08-01', '2026-08-31', 'PAID', 10342457, 2256470, 8085987,
     16, 'UGX', 'NORMAL', ARRAY[(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13'),(SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '14')]::bigint[], true, true, false, '2026-08-31', '2026-08-31', '2026-08-31', '{"lst":{"code":"UG-LST-KCCA","name":"Uganda Local Service Tax - KCCA Kampala (monthly)","rates":{},"version":1,"category":"LST","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2023-06-30T21:00:00.000Z","effectiveTo":null,"limits":{"bands":[{"max":200000,"monthly_amount":1250},{"max":300000,"monthly_amount":2500},{"max":400000,"monthly_amount":5000},{"max":600000,"monthly_amount":10000},{"max":1000000,"monthly_amount":20000},{"max":null,"monthly_amount":25000}],"months":[7,8,9,10],"min_gross":100000,"apply_to_payroll":true}},"nssf":{"code":"UG-NSSF-2023","name":"Uganda NSSF (5% employee / 10% employer)","rates":{"employee":0.05,"employer":0.1},"version":1,"category":"NSSF","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2023-06-30T21:00:00.000Z","effectiveTo":null,"limits":{"monthly_ceiling":0}},"paye":{"code":"UG-PAYE-2026","name":"Uganda PAYE (current)","version":2,"category":"PAYE","thresholds":[],"formula":null,"country":"UG","effectiveFrom":"2026-06-30T21:00:00.000Z","effectiveTo":null,"limits":{},"rates":[{"min":0,"max":335000,"rate":0},{"min":335000,"max":410000,"rate":0.1},{"min":410000,"max":485000,"rate":0.25},{"min":485000,"max":10000000,"rate":0.3},{"min":10000000,"max":null,"rate":0.1}]}}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1'),
              1678271, 430000, 2108271, 502857, 105414, 0, 150000, 0, 1442308, 2002857, 210828, 0, 665963, 'UGX', 'PS-2026-00000125', '{"register":{"basic":1678271,"transport":300000,"lunch":130000,"gross":2108271,"nssf":105414,"taxable":2002857,"payee":502857,"net":1500000,"overtime":161538,"cashAdvance":150000,"amountPaid":1442308,"balance":69230},"paye":{"tax":502857},"nssf":{"employee":105414,"employer":210828},"lst":{"amount":0},"taxableIncome":2002857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2'),
              926391, 430000, 1356391, 288571, 67820, 0, 500000, 0, 500000, 1288571, 135640, 0, 856391, 'UGX', 'PS-2026-00000126', '{"register":{"basic":926391,"transport":300000,"lunch":130000,"gross":1356391,"nssf":67820,"taxable":1288571,"payee":288571,"net":1000000,"overtime":0,"cashAdvance":500000,"amountPaid":500000,"balance":0},"paye":{"tax":288571},"nssf":{"employee":67820,"employer":135640},"lst":{"amount":0},"taxableIncome":1288571,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3'),
              776015, 430000, 1206015, 245714, 60301, 0, 500000, 0, 400000, 1145714, 120602, 0, 806015, 'UGX', 'PS-2026-00000127', '{"register":{"basic":776015,"transport":300000,"lunch":130000,"gross":1206015,"nssf":60301,"taxable":1145714,"payee":245714,"net":900000,"overtime":0,"cashAdvance":500000,"amountPaid":400000,"balance":0},"paye":{"tax":245714},"nssf":{"employee":60301,"employer":120602},"lst":{"amount":0},"taxableIncome":1145714,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4'),
              474887, 280000, 754887, 117143, 37744, 0, 100000, 0, 531370, 717143, 75488, 0, 223517, 'UGX', 'PS-2026-00000128', '{"register":{"basic":474887,"transport":150000,"lunch":130000,"gross":754887,"nssf":37744,"taxable":717143,"payee":117143,"net":600000,"overtime":55709,"cashAdvance":100000,"amountPaid":531370,"balance":24339},"paye":{"tax":117143},"nssf":{"employee":37744,"employer":75488},"lst":{"amount":0},"taxableIncome":717143,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5'),
              249323, 280000, 529323, 52857, 26466, 0, 44000, 0, 418981, 502857, 52932, 0, 110342, 'UGX', 'PS-2026-00000129', '{"register":{"basic":249323,"transport":150000,"lunch":130000,"gross":529323,"nssf":26466,"taxable":502857,"payee":52857,"net":450000,"overtime":24519,"cashAdvance":44000,"amountPaid":418981,"balance":11538},"paye":{"tax":52857},"nssf":{"employee":26466,"employer":52932},"lst":{"amount":0},"taxableIncome":502857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6'),
              249323, 280000, 529323, 52857, 26466, 0, 0, 0, 461538, 502857, 52932, 0, 67785, 'UGX', 'PS-2026-00000130', '{"register":{"basic":249323,"transport":150000,"lunch":130000,"gross":529323,"nssf":26466,"taxable":502857,"payee":52857,"net":450000,"overtime":22356,"cashAdvance":0,"amountPaid":461538,"balance":10818},"paye":{"tax":52857},"nssf":{"employee":26466,"employer":52932},"lst":{"amount":0},"taxableIncome":502857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7'),
              249323, 280000, 529323, 52857, 26466, 0, 0, 0, 460096, 502857, 52932, 0, 69227, 'UGX', 'PS-2026-00000131', '{"register":{"basic":249323,"transport":150000,"lunch":130000,"gross":529323,"nssf":26466,"taxable":502857,"payee":52857,"net":450000,"overtime":20192,"cashAdvance":0,"amountPaid":460096,"balance":10096},"paye":{"tax":52857},"nssf":{"employee":26466,"employer":52932},"lst":{"amount":0},"taxableIncome":502857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8'),
              249323, 280000, 529323, 52857, 26466, 0, 0, 0, 460096, 502857, 52932, 0, 69227, 'UGX', 'PS-2026-00000132', '{"register":{"basic":249323,"transport":150000,"lunch":130000,"gross":529323,"nssf":26466,"taxable":502857,"payee":52857,"net":450000,"overtime":20192,"cashAdvance":0,"amountPaid":460096,"balance":10096},"paye":{"tax":52857},"nssf":{"employee":26466,"employer":52932},"lst":{"amount":0},"taxableIncome":502857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9'),
              249323, 280000, 529323, 52857, 26466, 0, 0, 0, 460096, 502857, 52932, 0, 69227, 'UGX', 'PS-2026-00000133', '{"register":{"basic":249323,"transport":150000,"lunch":130000,"gross":529323,"nssf":26466,"taxable":502857,"payee":52857,"net":450000,"overtime":20192,"cashAdvance":0,"amountPaid":460096,"balance":10096},"paye":{"tax":52857},"nssf":{"employee":26466,"employer":52932},"lst":{"amount":0},"taxableIncome":502857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10'),
              249323, 280000, 529323, 52857, 26466, 0, 0, 0, 460096, 502857, 52932, 0, 69227, 'UGX', 'PS-2026-00000134', '{"register":{"basic":249323,"transport":150000,"lunch":130000,"gross":529323,"nssf":26466,"taxable":502857,"payee":52857,"net":450000,"overtime":20192,"cashAdvance":0,"amountPaid":460096,"balance":10096},"paye":{"tax":52857},"nssf":{"employee":26466,"employer":52932},"lst":{"amount":0},"taxableIncome":502857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11'),
              249323, 280000, 529323, 52857, 26466, 0, 50000, 0, 400000, 502857, 52932, 0, 129323, 'UGX', 'PS-2026-00000135', '{"register":{"basic":249323,"transport":150000,"lunch":130000,"gross":529323,"nssf":26466,"taxable":502857,"payee":52857,"net":450000,"overtime":0,"cashAdvance":50000,"amountPaid":400000,"balance":0},"paye":{"tax":52857},"nssf":{"employee":26466,"employer":52932},"lst":{"amount":0},"taxableIncome":502857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12'),
              323392, 0, 323392, 7222, 16170, 0, 50000, 0, 250000, 307222, 32340, 0, 73392, 'UGX', 'PS-2026-00000136', '{"register":{"basic":323392,"transport":0,"lunch":0,"gross":323392,"nssf":16170,"taxable":307222,"payee":7222,"net":300000,"overtime":0,"cashAdvance":50000,"amountPaid":250000,"balance":0},"paye":{"tax":7222},"nssf":{"employee":16170,"employer":32340},"lst":{"amount":0},"taxableIncome":307222,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000044'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13'),
              776015, 430000, 1206015, 245714, 60301, 0, 600000, 0, 300000, 1145714, 120602, 0, 906015, 'UGX', 'PS-2026-00000137', '{"register":{"basic":776015,"transport":300000,"lunch":130000,"gross":1206015,"nssf":60301,"taxable":1145714,"payee":245714,"net":900000,"overtime":0,"cashAdvance":600000,"amountPaid":300000,"balance":0},"paye":{"tax":245714},"nssf":{"employee":60301,"employer":120602},"lst":{"amount":0},"taxableIncome":1145714,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1'),
              1678271, 430000, 2108271, 502857, 105414, 0, 0, 0, 1569230, 2002857, 210828, 0, 539041, 'UGX', 'PS-2026-00000138', '{"register":{"basic":1678271,"transport":300000,"lunch":130000,"gross":2108271,"nssf":105414,"taxable":2002857,"payee":502857,"net":1500000,"previousBalance":69230,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":1569230},"paye":{"tax":502857},"nssf":{"employee":105414,"employer":210828},"lst":{"amount":0},"taxableIncome":2002857,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2'),
              926391, 430000, 1356391, 288571, 67820, 0, 400000, 50000, 550096, 1288571, 135640, 0, 806295, 'UGX', 'PS-2026-00000139', '{"register":{"basic":926391,"transport":300000,"lunch":130000,"gross":1356391,"nssf":67820,"taxable":1288571,"payee":288571,"net":1000000,"previousBalance":96,"reimbursement":0,"cashAdvance":400000,"otherDeductions":50000,"finalPayout":550096},"paye":{"tax":288571},"nssf":{"employee":67820,"employer":135640},"lst":{"amount":0},"taxableIncome":1288571,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3'),
              776015, 430000, 1206015, 245714, 60301, 0, 0, 0, 900000, 1145714, 120602, 0, 306015, 'UGX', 'PS-2026-00000140', '{"register":{"basic":776015,"transport":300000,"lunch":130000,"gross":1206015,"nssf":60301,"taxable":1145714,"payee":245714,"net":900000,"previousBalance":0,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":900000},"paye":{"tax":245714},"nssf":{"employee":60301,"employer":120602},"lst":{"amount":0},"taxableIncome":1145714,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4'),
              474887, 280000, 754887, 117143, 37744, 0, 0, 0, 624339, 717143, 75488, 0, 130548, 'UGX', 'PS-2026-00000141', '{"register":{"basic":474887,"transport":150000,"lunch":130000,"gross":754887,"nssf":37744,"taxable":717143,"payee":117143,"net":600000,"previousBalance":24339,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":624339},"paye":{"tax":117143},"nssf":{"employee":37744,"employer":75488},"lst":{"amount":0},"taxableIncome":717143,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5'),
              0, 0, 0, 0, 0, 0, 0, 0, 11538, 0, 0, 0, -11538, 'UGX', 'PS-2026-00000142', '{"register":{"basic":0,"transport":0,"lunch":0,"gross":0,"nssf":0,"taxable":0,"payee":0,"net":0,"previousBalance":11538,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":11538},"paye":{"tax":0},"nssf":{"employee":0,"employer":0},"lst":{"amount":0},"taxableIncome":0,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6'),
              0, 0, 0, 0, 0, 0, 0, 0, 10818, 0, 0, 0, -10818, 'UGX', 'PS-2026-00000143', '{"register":{"basic":0,"transport":0,"lunch":0,"gross":0,"nssf":0,"taxable":0,"payee":0,"net":0,"previousBalance":10818,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":10818},"paye":{"tax":0},"nssf":{"employee":0,"employer":0},"lst":{"amount":0},"taxableIncome":0,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7'),
              0, 0, 0, 0, 0, 0, 0, 0, 10096, 0, 0, 0, -10096, 'UGX', 'PS-2026-00000144', '{"register":{"basic":0,"transport":0,"lunch":0,"gross":0,"nssf":0,"taxable":0,"payee":0,"net":0,"previousBalance":10096,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":10096},"paye":{"tax":0},"nssf":{"employee":0,"employer":0},"lst":{"amount":0},"taxableIncome":0,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8'),
              0, 0, 0, 0, 0, 0, 0, 0, 10096, 0, 0, 0, -10096, 'UGX', 'PS-2026-00000145', '{"register":{"basic":0,"transport":0,"lunch":0,"gross":0,"nssf":0,"taxable":0,"payee":0,"net":0,"previousBalance":10096,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":10096},"paye":{"tax":0},"nssf":{"employee":0,"employer":0},"lst":{"amount":0},"taxableIncome":0,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9'),
              0, 0, 0, 0, 0, 0, 0, 0, 10096, 0, 0, 0, -10096, 'UGX', 'PS-2026-00000146', '{"register":{"basic":0,"transport":0,"lunch":0,"gross":0,"nssf":0,"taxable":0,"payee":0,"net":0,"previousBalance":10096,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":10096},"paye":{"tax":0},"nssf":{"employee":0,"employer":0},"lst":{"amount":0},"taxableIncome":0,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10'),
              0, 0, 0, 0, 0, 0, 0, 0, 10096, 0, 0, 0, -10096, 'UGX', 'PS-2026-00000147', '{"register":{"basic":0,"transport":0,"lunch":0,"gross":0,"nssf":0,"taxable":0,"payee":0,"net":0,"previousBalance":10096,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":10096},"paye":{"tax":0},"nssf":{"employee":0,"employer":0},"lst":{"amount":0},"taxableIncome":0,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11'),
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'UGX', 'PS-2026-00000148', '{"register":{"basic":0,"transport":0,"lunch":0,"gross":0,"nssf":0,"taxable":0,"payee":0,"net":0,"previousBalance":0,"reimbursement":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":0},"paye":{"tax":0},"nssf":{"employee":0,"employer":0},"lst":{"amount":0},"taxableIncome":0,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12'),
              323392, 0, 323392, 7222, 16170, 0, 150000, 0, 150000, 307222, 32340, 0, 173392, 'UGX', 'PS-2026-00000149', '{"register":{"basic":323392,"transport":0,"lunch":0,"gross":323392,"nssf":16170,"taxable":307222,"payee":7222,"net":300000,"previousBalance":0,"reimbursement":0,"cashAdvance":150000,"otherDeductions":0,"finalPayout":150000},"paye":{"tax":7222},"nssf":{"employee":16170,"employer":32340},"lst":{"amount":0},"taxableIncome":307222,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000045'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13'),
              776015, 430000, 1206015, 245714, 60301, 0, 100000, 0, 800000, 1145714, 120602, 0, 406015, 'UGX', 'PS-2026-00000150', '{"register":{"basic":776015,"transport":300000,"lunch":130000,"gross":1206015,"nssf":60301,"taxable":1145714,"payee":245714,"net":900000,"previousBalance":0,"reimbursement":0,"cashAdvance":100000,"otherDeductions":0,"finalPayout":800000},"paye":{"tax":245714},"nssf":{"employee":60301,"employer":120602},"lst":{"amount":0},"taxableIncome":1145714,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '1'),
              1849231, 300000, 2149231, 518019, 106212, 0, 0, 0, 1500030, 2124231, 212423, 25000, 649201, 'UGX', 'PS-2026-00000151', '{"register":{"basic":1849231,"transport":300000,"gross":2149231,"lst":25000,"taxable":2124231,"nssf5":106212,"employerNssf10":212423,"payee":518019,"net":1500000,"previousBalance":30,"cashAdvance":0,"otherDeductions":0,"finalPayout":1500030},"paye":{"tax":518019},"nssf":{"employee":106212,"employer":212423},"lst":{"amount":25000},"taxableIncome":2124231,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '2'),
              665799, 300000, 965799, 163740, 47165, 0, 0, 50000, 682490, 943299, 94330, 22500, 283309, 'UGX', 'PS-2026-00000152', '{"register":{"basic":665799,"transport":300000,"gross":965799,"lst":22500,"taxable":943299,"nssf5":47165,"employerNssf10":94330,"payee":163740,"net":732394,"previousBalance":96,"cashAdvance":0,"otherDeductions":50000,"finalPayout":682490},"paye":{"tax":163740},"nssf":{"employee":47165,"employer":94330},"lst":{"amount":22500},"taxableIncome":943299,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '3'),
              926154, 300000, 1226154, 241096, 60058, 0, 0, 0, 900000, 1201154, 120115, 25000, 326154, 'UGX', 'PS-2026-00000153', '{"register":{"basic":926154,"transport":300000,"gross":1226154,"lst":25000,"taxable":1201154,"nssf5":60058,"employerNssf10":120115,"payee":241096,"net":900000,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":900000},"paye":{"tax":241096},"nssf":{"employee":60058,"employer":120115},"lst":{"amount":25000},"taxableIncome":1201154,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '4'),
              607116, 150000, 757116, 102635, 36981, 0, 0, 0, 600039, 739616, 73962, 17500, 157077, 'UGX', 'PS-2026-00000154', '{"register":{"basic":607116,"transport":150000,"gross":757116,"lst":17500,"taxable":739616,"nssf5":36981,"employerNssf10":73962,"payee":102635,"net":600000,"previousBalance":39,"cashAdvance":0,"otherDeductions":0,"finalPayout":600039},"paye":{"tax":102635},"nssf":{"employee":36981,"employer":73962},"lst":{"amount":17500},"taxableIncome":739616,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '5'),
              226539, 150000, 376539, 3654, 18577, 0, 0, 0, 349308, 371539, 37154, 5000, 27231, 'UGX', 'PS-2026-00000155', '{"register":{"basic":226539,"transport":150000,"gross":376539,"lst":5000,"taxable":371539,"nssf5":18577,"employerNssf10":37154,"payee":3654,"net":349308,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":349308},"paye":{"tax":3654},"nssf":{"employee":18577,"employer":37154},"lst":{"amount":5000},"taxableIncome":371539,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '6'),
              237965, 150000, 387965, 4797, 19148, 0, 0, 0, 359020, 382965, 38297, 5000, 28945, 'UGX', 'PS-2026-00000156', '{"register":{"basic":237965,"transport":150000,"gross":387965,"lst":5000,"taxable":382965,"nssf5":19148,"employerNssf10":38297,"payee":4797,"net":359020,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":359020},"paye":{"tax":4797},"nssf":{"employee":19148,"employer":38297},"lst":{"amount":5000},"taxableIncome":382965,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '7'),
              237965, 150000, 387965, 4797, 19148, 0, 0, 0, 359020, 382965, 38297, 5000, 28945, 'UGX', 'PS-2026-00000157', '{"register":{"basic":237965,"transport":150000,"gross":387965,"lst":5000,"taxable":382965,"nssf5":19148,"employerNssf10":38297,"payee":4797,"net":359020,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":359020},"paye":{"tax":4797},"nssf":{"employee":19148,"employer":38297},"lst":{"amount":5000},"taxableIncome":382965,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '8'),
              237965, 150000, 387965, 4797, 19148, 0, 0, 0, 359020, 382965, 38297, 5000, 28945, 'UGX', 'PS-2026-00000158', '{"register":{"basic":237965,"transport":150000,"gross":387965,"lst":5000,"taxable":382965,"nssf5":19148,"employerNssf10":38297,"payee":4797,"net":359020,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":359020},"paye":{"tax":4797},"nssf":{"employee":19148,"employer":38297},"lst":{"amount":5000},"taxableIncome":382965,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '9'),
              237965, 150000, 387965, 4797, 19148, 0, 0, 0, 359020, 382965, 38297, 5000, 28945, 'UGX', 'PS-2026-00000159', '{"register":{"basic":237965,"transport":150000,"gross":387965,"lst":5000,"taxable":382965,"nssf5":19148,"employerNssf10":38297,"payee":4797,"net":359020,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":359020},"paye":{"tax":4797},"nssf":{"employee":19148,"employer":38297},"lst":{"amount":5000},"taxableIncome":382965,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '10'),
              237965, 150000, 387965, 4797, 19148, 0, 0, 0, 359020, 382965, 38297, 5000, 28945, 'UGX', 'PS-2026-00000160', '{"register":{"basic":237965,"transport":150000,"gross":387965,"lst":5000,"taxable":382965,"nssf5":19148,"employerNssf10":38297,"payee":4797,"net":359020,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":359020},"paye":{"tax":4797},"nssf":{"employee":19148,"employer":38297},"lst":{"amount":5000},"taxableIncome":382965,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '11'),
              237965, 150000, 387965, 4797, 19148, 0, 0, 0, 359020, 382965, 38297, 5000, 28945, 'UGX', 'PS-2026-00000161', '{"register":{"basic":237965,"transport":150000,"gross":387965,"lst":5000,"taxable":382965,"nssf5":19148,"employerNssf10":38297,"payee":4797,"net":359020,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":359020},"paye":{"tax":4797},"nssf":{"employee":19148,"employer":38297},"lst":{"amount":5000},"taxableIncome":382965,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '12'),
              320789, 0, 320789, 0, 15789, 0, 50000, 0, 250000, 315789, 31579, 5000, 70789, 'UGX', 'PS-2026-00000162', '{"register":{"basic":320789,"transport":0,"gross":320789,"lst":5000,"taxable":315789,"nssf5":15789,"employerNssf10":31579,"payee":0,"net":300000,"previousBalance":0,"cashAdvance":50000,"otherDeductions":0,"finalPayout":250000},"paye":{"tax":0},"nssf":{"employee":15789,"employer":31579},"lst":{"amount":5000},"taxableIncome":315789,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '13'),
              926154, 300000, 1226154, 241096, 60058, 0, 0, 0, 900000, 1201154, 120115, 25000, 326154, 'UGX', 'PS-2026-00000163', '{"register":{"basic":926154,"transport":300000,"gross":1226154,"lst":25000,"taxable":1201154,"nssf5":60058,"employerNssf10":120115,"payee":241096,"net":900000,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":900000},"paye":{"tax":241096},"nssf":{"employee":60058,"employer":120115},"lst":{"amount":25000},"taxableIncome":1201154,"earnings":[],"deductions":[]}'::jsonb);
INSERT INTO payroll_items
      (payroll_id, employee_id, basic_pay, allowances, gross_pay, paye, nssf, loans, advances, other_deductions, net_pay, taxable_income, employer_nssf, lst, total_deductions, currency, payslip_no, breakdown)
      VALUES ((SELECT id FROM payrolls WHERE company_id = 2 AND payroll_no = 'PAY-2026-00000046'),
              (SELECT id FROM employees WHERE company_id = 2 AND tenant_id = 2 AND employee_no = '14'),
              692885, 300000, 992885, 171866, 48519, 0, 0, 0, 750000, 970385, 97039, 22500, 242885, 'UGX', 'PS-2026-00000164', '{"register":{"basic":692885,"transport":300000,"gross":992885,"lst":22500,"taxable":970385,"nssf5":48519,"employerNssf10":97039,"payee":171866,"net":750000,"previousBalance":0,"cashAdvance":0,"otherDeductions":0,"finalPayout":750000},"paye":{"tax":171866},"nssf":{"employee":48519,"employer":97039},"lst":{"amount":22500},"taxableIncome":970385,"earnings":[],"deductions":[]}'::jsonb);
SELECT setval('payrolls_id_seq', GREATEST(632, (SELECT last_value FROM payrolls_id_seq)));
SELECT setval('payroll_items_id_seq', GREATEST((SELECT COALESCE(max(id), 1) FROM payroll_items), (SELECT last_value FROM payroll_items_id_seq)));
SELECT setval('users_id_seq', GREATEST((SELECT COALESCE(max(id), 1) FROM users), (SELECT last_value FROM users_id_seq)));
SELECT setval('employees_id_seq', GREATEST((SELECT COALESCE(max(id), 1) FROM employees), (SELECT last_value FROM employees_id_seq)));
COMMIT;
SELECT 'run:' || payroll_no || ':emp=' || (SELECT count(*) FROM payroll_items pi WHERE pi.payroll_id = payrolls.id)
       || ':gross=' || gross_total || ':net=' || net_total AS summary
FROM payrolls WHERE id IN (630, 631, 632) ORDER BY id;
SELECT 'users:' || string_agg(username || '=' || email, ',' ORDER BY username) AS accounts
FROM users WHERE tenant_id = 2 AND email IN ('anthony.chege@hopedesign.co.ug','guillaume.niyonzima@hopedesign.co.ug','dinah.hannah@hopedesign.co.ug','solomon.munyagwa@hopedesign.co.ug','tabu.derrick@hopedesign.co.ug','emile.niyungeko@hopedesign.co.ug','gloria.nakakawa@hopedesign.co.ug','racheal.tagulwa@hopedesign.co.ug','lorraine.ninihazwe@hopedesign.co.ug','shamirah.nantume@hopedesign.co.ug','viola.akatikwasa@hopedesign.co.ug','mbeba.sebikali@hopedesign.co.ug','nanette.arakaza@hopedesign.co.ug','nyirinkindi.annonciata@hopedesign.co.ug');
