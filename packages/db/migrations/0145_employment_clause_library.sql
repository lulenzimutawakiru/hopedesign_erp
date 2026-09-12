-- ============================================================
-- 0145 HR Contract Builder: modern professional clause library
-- ============================================================
-- The bundled clause library covered the statutory spine of the
-- Employment Act (Cap. 226, Laws of Uganda), as amended, well. The
-- commercial layer - confidentiality, intellectual property, data
-- protection, company property, conflicts of interest, anti-bribery,
-- fraud and conduct - was one-line placeholder text, and the two
-- categories the composer already offers, "IT Acceptable Use" and
-- "Cybersecurity", had no clauses at all.
--
-- This migration:
--   1. rewrites the thin commercial clauses to professional drafting
--      (definitions, carve-outs, duration, survival, remedies and
--      return/destruction duties);
--   2. adds the missing modern layer: IT acceptable use, monitoring,
--      AI tooling, remote/hybrid working and BYOD, cybersecurity and
--      data-breach reporting, plus general provisions;
--   3. advances the bundled contract templates so the new clauses
--      actually appear in a printed contract.
--
-- Mechanics: contract_clauses is a head table (one row per code); the
-- superseded wording is snapshotted into contract_clause_versions,
-- mirroring createClauseVersion() in apps/api/src/services/contracts.ts.
-- The rewrite is keyed on the text actually changing, so re-running the
-- migration is a no-op and never stacks duplicate versions.
--
-- Ownership: rows are seeded with created_by = NULL, so they are
-- centrally controlled (isCentrallyControlled) and frozen against tenant
-- edits, exactly like the existing statutory clauses.
--
-- Legal review: citations are drawn from the consolidated Act and from
-- the baseline already configured in legal_rules. Drafted commercial
-- wording is marked PENDING_REVIEW so a qualified reviewer must sign it
-- off before it is relied on.
-- ============================================================

DROP TABLE IF EXISTS _clause_seed;
CREATE TEMP TABLE _clause_seed (
  clause_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  required_flag TEXT NOT NULL,
  legal_reference TEXT,
  validation_status TEXT NOT NULL,
  clause_text TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO _clause_seed
  (clause_code, name, category, required_flag, legal_reference, validation_status, clause_text)
VALUES
('CONFIDENTIALITY', 'Confidentiality', 'Confidentiality', 'CONDITIONAL', NULL, 'PENDING_REVIEW',
 'The Employee shall not, during employment or at any time after it ends, use, disclose or make available to any person any Confidential Information of the Employer, its clients, suppliers or employees, except so far as is necessary to perform the Employee''s duties or as required by law. Confidential Information means all non-public information in any form, including business plans, pricing and tender information, client and candidate data, designs, drawings, source code, financial records, trade secrets and know-how, whether or not it is marked confidential. This obligation does not apply to information that is or becomes public through no breach of this contract, that the Employee lawfully knew before employment, or that a court or regulator lawfully orders to be disclosed, in which case the Employee shall, so far as lawfully possible, notify the Employer before disclosing it. The Employee shall not copy Confidential Information to personal devices, personal email accounts or unapproved cloud services, and shall return or securely destroy all Confidential Information and copies of it on request and on termination. These obligations continue after termination for as long as the information remains confidential and are in addition to any duty of confidence at common law or under the Employment Act (Cap. 226), as amended.'),
('INTELLECTUAL_PROPERTY', 'Intellectual Property', 'Intellectual Property', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'All intellectual property rights, including copyright, design rights, patent rights, trade mark rights and database rights, in any work, invention, design, software, document, content, data set or other material created by the Employee in the course of employment, or using the Employer''s equipment, time, premises or Confidential Information, vest in the Employer absolutely on creation. The Employee assigns to the Employer all such rights, including all rights of renewal, extension and revival, and waives all moral rights in that material to the fullest extent permitted by law. The Employee shall promptly disclose all such material to the Employer, shall execute any document and do anything reasonably required to perfect, register, maintain or enforce those rights, and shall not apply to register any of them in the Employee''s own name. The Employee shall not incorporate third-party, open-source or AI-generated material into the Employer''s products or deliverables without prior written approval and shall comply with the licence terms of any approved material. Intellectual property created by the Employee outside the course of employment and before this contract, including anything listed in an agreed schedule of prior rights, remains the Employee''s property, and the Employee grants the Employer a non-exclusive licence to use it so far as it is embedded in the Employer''s products.'),
('DATA_PROTECTION', 'Data Protection', 'Data Protection', 'CONDITIONAL', 'Data Protection and Privacy Act, 2019', 'PENDING_REVIEW',
 'The Employee shall comply with the Data Protection and Privacy Act, 2019, the regulations made under it and the Employer''s data protection policies when collecting, accessing, using, storing, sharing, transferring or disposing of personal data. The Employee shall process personal data only for purposes authorised by the Employer, shall apply the principles of lawfulness, purpose limitation, data minimisation, accuracy, storage limitation, security and accountability, shall respect the rights of data subjects, and shall not transfer personal data outside Uganda without the Employer''s written authorisation. The Employee shall report every suspected or actual personal data breach, loss or unauthorised access to the Employer immediately and in any event within 24 hours of becoming aware of it, and shall cooperate with the Employer''s investigation and with any notification to the Personal Data Protection Office or to affected data subjects. On termination the Employee shall return or securely delete all personal data in the Employee''s possession, shall not retain it on personal devices or personal accounts, and shall continue to protect it as Confidential Information.'),
('COMPANY_PROPERTY', 'Company Property', 'Company Property', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'The Employer shall provide the equipment, tools, devices, vehicles, uniforms, access credentials and other property that the Employee reasonably requires to perform the role. The Employee shall use that property only for authorised purposes, keep it in good order, follow any care and maintenance instructions, and report any loss, damage, theft or fault immediately. The Employee shall not sell, pledge, lend, remove from the workplace without authority, or use Employer property for personal gain or for any business other than the Employer''s. On request, and in any event on termination, the Employee shall return all Employer property in the Employee''s possession or control, including devices, keys, access cards, documents and data, in good condition, and shall permit the Employer to inspect the property and remove its data from it. Where property is lost or damaged through the Employee''s negligence, wilful misconduct or failure to follow reasonable care instructions, the Employer may recover the cost after giving the Employee a reasonable opportunity to be heard, subject to the limits on deductions from wages under the Employment Act (Cap. 226), as amended.'),
('IT_ACCEPTABLE_USE', 'IT Acceptable Use', 'IT Acceptable Use', 'CONDITIONAL', 'Computer Misuse Act, 2011', 'PENDING_REVIEW',
 'The Employer''s information systems, devices, accounts, network and internet access are provided for authorised business purposes, and the Employee shall use them in accordance with this contract, the Employer''s IT and acceptable use policies and applicable law, including the Computer Misuse Act, 2011. The Employee shall use only the credentials issued to the Employee, keep passwords and multi-factor authentication devices confidential, shall not share accounts or access, shall not attempt to bypass security controls, and shall not install unapproved software or connect unauthorised devices or storage media to the Employer''s network. Prohibited use includes accessing, storing, creating or distributing unlawful, defamatory, obscene, harassing or discriminatory material; using the Employer''s systems for personal business, unauthorised remote access, unlicensed software or cryptocurrency mining; and any use that damages the Employer''s reputation or breaches the Employer''s data protection obligations. The Employee shall report suspected security incidents, phishing attempts, malware and unauthorised access immediately, and a breach of this clause may result in withdrawal of access and disciplinary action up to and including summary dismissal.'),
('IT_MONITORING', 'Monitoring of Employer Systems', 'IT Acceptable Use', 'CONDITIONAL', 'Data Protection and Privacy Act, 2019', 'PENDING_REVIEW',
 'The Employee acknowledges that the Employer''s systems, devices, network, email and other business communications are provided for business use and may be monitored, logged, retained and audited in order to protect the Employer''s information, meet legal and regulatory duties, and investigate suspected misconduct or security incidents. Monitoring shall be proportionate, shall be carried out in accordance with the Employer''s policies and applicable law, including the Data Protection and Privacy Act, 2019, and shall not extend to the Employee''s personal devices or personal accounts unless the Employee authorises access or disclosure is lawfully required. The Employee shall have no expectation of privacy in respect of data created, sent, received or stored on the Employer''s systems in the course of work, and shall not use those systems for communications or material the Employee would not wish the Employer to see. The Employer shall notify the Employee of the scope of monitoring in force, shall handle any personal data collected through monitoring in accordance with its data protection obligations, and shall restrict access to monitoring output to those who need it for the purposes stated in this clause.')
,
('AI_TOOL_USE', 'Artificial Intelligence Tools', 'IT Acceptable Use', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'The Employee may use generative or other artificial intelligence tools in the course of employment only where the tool and the intended use have been approved by the Employer, and shall not enter the Employer''s Confidential Information, client, candidate or employee personal data, source code or unpublished business information into any public or unapproved artificial intelligence service. Where an approved tool is used to produce work product, the Employee shall verify all output for accuracy, completeness and legal compliance, remains responsible for the quality of the work delivered, and shall disclose the use of artificial intelligence assistance where the Employer, a client or a regulator requires it. The Employee shall comply with the licence and usage terms of any approved tool, shall not use output in a manner that infringes third-party intellectual property rights, and shall not present artificial intelligence output as the Employee''s original professional judgement where that would mislead. Nothing in this clause reduces the Employer''s ownership of work product created in the course of employment, which is governed by the Intellectual Property clause of this contract.'),
('BYOD_AND_REMOTE_WORK', 'Remote Working and Personal Devices', 'IT Acceptable Use', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'Where the Employer approves remote, hybrid or mobile working, the Employee shall work at the agreed location during the agreed hours, remain contactable and available through the Employer''s approved channels, and maintain a safe, secure and reasonably private working environment. The Employee shall protect the Employer''s information while working remotely by using Employer-issued or approved devices where required, keeping devices patched and encrypted, using multi-factor authentication, avoiding public or unsecured networks for access to business systems, and ensuring that Confidential Information cannot be seen or accessed by third parties. Where the Employee uses a personal device for business purposes, the Employee consents to the installation of Employer security software on that device, to the separation or removal of Employer data on termination, and to the Employer inspecting the business data held on that device, and the Employer shall not access the Employee''s personal data. The Employer is not responsible for the Employee''s home internet, power or personal equipment costs unless it has agreed in writing to reimburse them, and a remote or hybrid arrangement may be varied or withdrawn by the Employer on reasonable notice.'),
('CYBERSECURITY', 'Cybersecurity', 'Cybersecurity', 'CONDITIONAL', 'Computer Misuse Act, 2011', 'PENDING_REVIEW',
 'The Employee shall take reasonable care to protect the Employer''s systems, accounts and data from unauthorised access, loss, alteration or damage, including by using strong unique passwords, enabling multi-factor authentication, locking unattended devices, applying security updates, and exercising caution with email attachments, links, removable media and unsolicited requests for payment or credentials. The Employee shall not attempt to gain or grant unauthorised access to any system or data, shall not disable, remove or interfere with security controls, and shall not use unauthorised shadow IT, workarounds or third-party services to store or process the Employer''s data. The Employee shall report any suspected or actual security incident, phishing attempt, malware, suspicious payment instruction or compromised credential to the Employer immediately, shall preserve evidence, and shall cooperate fully with the Employer''s investigation. Failure to comply with this clause may constitute misconduct and a breach of this contract, whether or not the failure results in loss to the Employer.'),
('DATA_BREACH_REPORTING', 'Data Breach Reporting', 'Cybersecurity', 'CONDITIONAL', 'Data Protection and Privacy Act, 2019', 'PENDING_REVIEW',
 'The Employee shall report every suspected or actual data breach, loss of Employer data, loss or theft of a device holding Employer data, misdirected communication and unauthorised disclosure to the Employer''s designated contact immediately and in any event within 24 hours of becoming aware of it, and shall not attempt to conceal the matter, resolve it alone or investigate it without authority. The Employee shall give accurate information, preserve logs and other evidence, and cooperate with the Employer''s investigation and with any notification to the Personal Data Protection Office, affected data subjects or other authorities. Where a breach arises from the Employee''s failure to follow the Employer''s security, data protection or acceptable use requirements, the Employer may take disciplinary action and may recover losses caused by the failure, subject to the limits on deductions from wages under the Employment Act (Cap. 226), as amended.'),
('CONFLICT_OF_INTEREST', 'Conflict of Interest', 'Conflict of Interest', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'The Employee shall act in the Employer''s best interests and shall avoid any situation in which the Employee''s personal, financial or family interests conflict, or could reasonably appear to conflict, with the Employee''s duties. The Employee shall disclose in writing to the Employer, promptly and in any event before the matter is acted on, any outside employment, business, consultancy, directorship, shareholding, family relationship or other interest that might conflict, including any interest in a supplier, client, competitor, contractor or bidder of the Employer. The Employee shall not accept any personal benefit from a person doing business with the Employer, shall not use the Employer''s position, information, funds or property for personal advantage, and shall recuse themselves from any decision in which the Employee has a personal or financial interest. The Employer may require the Employee to relinquish or cease an outside interest that cannot be managed by other means, and a failure to disclose a conflict of interest is a breach of this contract.'),
('NON_SOLICITATION', 'Non-Solicitation', 'Non-Solicitation', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'During employment and for twelve months after it ends, the Employee shall not, directly or indirectly, on the Employee''s own account or for any other person, solicit, entice away or attempt to solicit or entice away from the Employer any client, customer, supplier, contractor or business contact with whom the Employee dealt or about whom the Employee held Confidential Information during the twelve months before termination, for the purpose of providing goods or services that compete with the Employer''s business. During the same period the Employee shall not solicit, entice away or employ any employee, consultant or contractor of the Employer with whom the Employee worked, or induce any of them to end their engagement with the Employer. This clause does not prevent the Employee from seeking or accepting employment generally, from dealing with a person who approaches the Employee without solicitation by the Employee, or from any activity that would be an unreasonable restraint of trade, and nothing in this clause restricts the Employee''s statutory rights under the Employment Act (Cap. 226), as amended. The Employee acknowledges that these restrictions are reasonable to protect the Employer''s legitimate business interests and are in addition to the Employee''s duty of confidentiality.')
,
('ANTI_BRIBERY', 'Anti-Bribery', 'Anti-Bribery', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'The Employee shall not offer, promise, give, request, agree to receive or accept any bribe, kickback, secret commission, facilitation payment or other improper advantage, whether directly or through a third party, in connection with the Employer''s business. The Employee shall not give or accept gifts, hospitality, entertainment or travel that are intended to influence a decision, that are excessive in value or frequency, or that would create a sense of obligation, and shall record and obtain approval for any gift or hospitality above the threshold set in the Employer''s anti-bribery policy. The Employee shall carry out reasonable due diligence on agents, intermediaries, consultants and other third parties acting for the Employer, shall never use a third party to do anything this clause prohibits, and shall report any request for or offer of an improper payment to the Employer immediately. A breach of this clause is a serious matter that may lead to summary dismissal, and the Employer may recover any loss and report the matter to the relevant authorities.'),
('ANTI_FRAUD', 'Anti-Fraud', 'Anti-Fraud', 'OPTIONAL', NULL, 'PENDING_REVIEW',
 'The Employee shall not commit, facilitate or conceal any fraud or dishonest act against the Employer or any third party, including the falsification of records, invoices, receipts, attendance, timesheets, expense claims, payroll or stock data, the misappropriation or diversion of funds, assets or data, collusion with suppliers, clients or other employees, and the deliberate misstatement of information given to the Employer or to a regulator. The Employee shall maintain accurate records, obtain approval for expenditure within the limits of the role, safeguard the Employer''s funds and assets, and promptly report any suspected fraud, irregularity or control weakness. The Employer may investigate any suspected fraud, including by auditing records and systems, and may suspend the Employee on full pay during an investigation where its policy or the law permits. Where fraud is established, the Employer may summarily dismiss the Employee, recover its losses and refer the matter to the relevant authorities, without prejudice to its other rights.'),
('WORKPLACE_CONDUCT', 'Workplace Conduct', 'Workplace Conduct', 'REQUIRED', 'Employment Act (Cap. 226), s.6A, as amended', 'PENDING_REVIEW',
 'The Employee shall treat colleagues, clients, suppliers and members of the public with dignity and respect, and shall not engage in bullying, intimidation, harassment, victimisation, discrimination, violence, abusive language or any other conduct that creates a hostile or unsafe working environment, whether in the workplace, at work-related events or through electronic communication. The Employee shall comply with the Employer''s policies, including those on sexual harassment, non-discrimination, alcohol and substance use, health and safety, security and dress, and shall not publish content on social media that identifies the Employer, its clients or colleagues in a manner that is defamatory, misleading or damaging to the Employer. The Employee shall not engage in criminal conduct, shall not attend work under the influence of alcohol or unlawful drugs, and shall not bring unauthorised weapons onto the Employer''s premises. The Employee shall report any breach of this clause, including any conduct that may amount to harassment or intimidation, to the Employer, and acknowledges that a copy of the Employer''s policy prohibiting intimidation and harassment is displayed at the workplace as required by the Employment Act (Cap. 226), s.6A, as amended. A breach of this clause may lead to disciplinary action up to and including summary dismissal.'),
('GRIEVANCE', 'Grievance Procedure', 'Grievance', 'REQUIRED', NULL, 'PENDING_REVIEW',
 'An employee who has a grievance relating to employment, including a grievance about treatment, pay, working conditions, harassment or a management decision, may raise it under the Employer''s grievance procedure without fear of victimisation or detriment. The Employee shall first raise the matter in writing with the Employee''s immediate supervisor and, if it is not resolved within seven working days, may escalate it in writing to the next level of management and thereafter to the Human Resources function. The Employer shall acknowledge a grievance in writing within three working days, consider it fairly, give the Employee an opportunity to be heard and to be accompanied by a colleague, and communicate the outcome and the reasons for it within fourteen working days of receiving the grievance. Where a grievance concerns the Employee''s supervisor or another person in the escalation line, it may be raised directly with the next appropriate level of management, and a grievance arising from intimidation or harassment may be raised at any level or directly with the Human Resources function.'),
('DISPUTE_RESOLUTION', 'Dispute Resolution', 'Dispute Resolution', 'REQUIRED', 'Employment Act (Cap. 226), as amended', 'PENDING_REVIEW',
 'Where a dispute or difference arises between the Employer and the Employee concerning this contract, the parties shall first attempt to resolve it through the Employer''s grievance or disciplinary procedure, as applicable, acting in good faith and within the time limits of that procedure. If the dispute is not resolved internally within thirty days, either party may refer it to conciliation or mediation before an agreed mediator, and the parties shall share the mediator''s costs equally unless they agree otherwise. If the dispute remains unresolved, either party may refer it to the Labour Officer for conciliation and thereafter to the Industrial Court in accordance with the Employment Act (Cap. 226), as amended, and the Labour Disputes (Arbitration and Settlement) Act, as applicable. Nothing in this clause prevents either party from referring a dispute to the Labour Officer or the Industrial Court at any time where the law permits, or from exercising any statutory right in relation to the dispute.')
,
('GOVERNING_LAW', 'Governing Law', 'Applicable Law', 'REQUIRED', NULL, 'PENDING_REVIEW',
 'This contract is governed by and shall be construed in accordance with the laws of the Republic of Uganda, and the courts and tribunals of Uganda shall have jurisdiction over any dispute arising under it, subject to the dispute resolution clause of this contract.'),
('GENERAL_PROVISIONS', 'General Provisions', 'General', 'REQUIRED', NULL, 'PENDING_REVIEW',
 'This contract, together with its schedules and the Employer''s policies incorporated by reference, constitutes the entire agreement between the parties and supersedes all previous offers, representations, negotiations and agreements, whether written or oral, relating to the employment. No variation of this contract is effective unless it is in writing and signed by the Employee and an authorised representative of the Employer, and no waiver of any right or breach is effective unless it is in writing and shall not be treated as a waiver of any later breach. If any provision of this contract is held to be invalid or unenforceable, that provision shall be severed only to the minimum extent necessary and the remaining provisions shall continue in full force and effect. The Employer''s policies and handbooks do not form part of this contract and may be amended by the Employer from time to time on reasonable notice, and the Employee shall comply with them as amended. A notice under this contract shall be given in writing and delivered by hand, by registered post or by the Employer''s official email to the address or account last notified by the party, and is treated as received on delivery, on the second working day after posting or on transmission, as applicable.'),
('ALLOWANCES', 'Allowances', 'Allowances', 'CONDITIONAL', NULL, 'PENDING_REVIEW',
 'The Employer shall pay the Employee the allowances set out in Schedule A - Allowances and Benefits, at the rates and in the manner stated in that Schedule, in addition to the basic salary. Allowances are paid to meet the Employee''s costs of the role, are not part of basic salary for the purpose of calculating statutory terminal benefits unless the law requires otherwise, and may be reviewed, varied or withdrawn by the Employer on reasonable notice where the underlying circumstances change. The Employee shall claim any reimbursable expense within a reasonable period and in accordance with the Employer''s expense policy, supported by receipts and approvals, and shall not claim any expense that was not incurred for the Employer''s business.'),
('OVERTIME', 'Overtime', 'Overtime', 'CONDITIONAL', 'Employment Act (Cap. 226), s.52, as amended', 'PENDING_REVIEW',
 'Overtime shall be worked only where the Employee is authorised by the Employer in advance, or where it is necessary to meet an emergency affecting the Employer''s operations, and shall be recorded in the Employer''s attendance or timekeeping system. The Employer shall pay overtime at the rate required by the Employment Act (Cap. 226), s.52, as amended, or, with the Employee''s agreement, grant time off in lieu at the equivalent rate within the period and in accordance with the Employer''s overtime policy. The Employee is not entitled to overtime pay for time worked beyond the ordinary working hours where the Employee holds a role that the law or the Employer''s policy treats as not eligible for overtime, or where the time is not authorised and recorded. Nothing in this clause reduces any statutory entitlement of the Employee.'),
('WORKING_HOURS', 'Working Hours', 'Working Hours', 'REQUIRED', 'Employment Act (Cap. 226), s.52, as amended', 'PENDING_REVIEW',
 'The Employee''s ordinary working hours are {{working_hours}} per week, worked on the days and at the times set out in the schedule to this contract, as the Employer may reasonably vary on notice to meet its operational needs. The Employee shall comply with the Employer''s timekeeping, attendance and remote-working arrangements and shall record attendance as required. The Employer shall comply with the Employment Act (Cap. 226), s.52, as amended, on hours of work and shall not require the Employee to work hours that contravene that section, except as the law permits. The Employee is entitled to the statutory rest breaks, weekly rest day and public holidays, as provided in this contract and by the Employment Act (Cap. 226), ss.50, 52 and 53, as amended.')
;

-- ============================================================
-- 1. Snapshot the wording that is about to be superseded.
--    Centrally controlled rows only (created_by IS NULL): a clause
--    authored by the tenant is never rewritten by a system migration.
-- ============================================================
INSERT INTO contract_clause_versions (
  company_id, tenant_id, clause_id, version, name, category, text, status,
  effective_from, effective_to, legal_reference, legal_rule_id, required_flag,
  applicable_employee_types, applicable_contract_types, rule_conditions,
  conflicts_with, created_by, law, law_chapter, section, law_source, validation_status
)
SELECT cc.company_id, cc.tenant_id, cc.id, cc.version, cc.name, cc.category, cc.text, cc.status,
       cc.effective_from, cc.effective_to, cc.legal_reference, cc.legal_rule_id, cc.required_flag,
       cc.applicable_employee_types, cc.applicable_contract_types, cc.rule_conditions,
       cc.conflicts_with, cc.created_by, cc.law, cc.law_chapter, cc.section, cc.law_source,
       cc.validation_status
FROM contract_clauses cc
JOIN _clause_seed s ON s.clause_code = upper(cc.clause_code)
WHERE cc.deleted_at IS NULL
  AND cc.created_by IS NULL
  AND (cc.text <> s.clause_text
       OR cc.name <> s.name
       OR cc.category <> s.category
       OR cc.required_flag <> s.required_flag
       OR COALESCE(cc.legal_reference, '') <> COALESCE(s.legal_reference, ''))
ON CONFLICT (clause_id, version) DO NOTHING;

-- ============================================================
-- 2. Advance the head row to the modern wording.
-- ============================================================
UPDATE contract_clauses cc
SET name = s.name,
    category = s.category,
    text = s.clause_text,
    required_flag = s.required_flag,
    legal_reference = s.legal_reference,
    applicable_contract_types = ARRAY['PERMANENT','FIXED_TERM','PROBATIONARY','PART_TIME','TEMPORARY','APPRENTICESHIP','CASUAL','INTERNSHIP','SECONDMENT','RENEWAL']::text[],
    validation_status = s.validation_status,
    version = cc.version + 1,
    status = 'ACTIVE',
    effective_from = CURRENT_DATE,
    updated_at = now()
FROM _clause_seed s
WHERE s.clause_code = upper(cc.clause_code)
  AND cc.deleted_at IS NULL
  AND cc.created_by IS NULL
  AND (cc.text <> s.clause_text
       OR cc.name <> s.name
       OR cc.category <> s.category
       OR cc.required_flag <> s.required_flag
       OR COALESCE(cc.legal_reference, '') <> COALESCE(s.legal_reference, ''));

-- ============================================================
-- 3. Add the clauses the library never had (IT Acceptable Use and
--    Cybersecurity had no rows at all, so the composer offered
--    categories with nothing to choose from).
-- ============================================================
INSERT INTO contract_clauses (
  company_id, tenant_id, clause_code, name, category, text, version, status,
  effective_from, legal_reference, required_flag, applicable_employee_types,
  applicable_contract_types, rule_conditions, conflicts_with, created_by,
  validation_status
)
SELECT c.id, c.tenant_id, s.clause_code, s.name, s.category, s.clause_text, 1, 'ACTIVE',
       CURRENT_DATE, s.legal_reference, s.required_flag, NULL,
       ARRAY['PERMANENT','FIXED_TERM','PROBATIONARY','PART_TIME','TEMPORARY','APPRENTICESHIP','CASUAL','INTERNSHIP','SECONDMENT','RENEWAL']::text[],
       '[]'::jsonb, NULL, NULL, s.validation_status
FROM companies c
CROSS JOIN _clause_seed s
WHERE NOT EXISTS (
  SELECT 1 FROM contract_clauses cc
  WHERE cc.company_id = c.id AND upper(cc.clause_code) = s.clause_code
);

-- ============================================================
-- 4. Templates: the bundled employment contracts predate the modern
--    layer, so the new clauses would never reach a printed contract.
--    A new approved version is published for each contract template.
--    Guarded on the modern marker so re-running does not stack
--    duplicate versions.
-- ============================================================
DROP TABLE IF EXISTS _tmpl_next;
CREATE TEMP TABLE _tmpl_next ON COMMIT DROP AS
SELECT t.id AS template_id, t.company_id, t.tenant_id, t.code, t.name,
       max(v.version) + 1 AS next_version
FROM contract_templates t
JOIN contract_template_versions v ON v.template_id = t.id
WHERE t.code IN ('TMPL-PERM', 'TMPL-FIXED', 'TMPL-PROB')
  AND NOT EXISTS (
    SELECT 1 FROM contract_template_versions x
    WHERE x.template_id = t.id AND x.sections::text LIKE '%CYBERSECURITY%'
  )
GROUP BY t.id, t.company_id, t.tenant_id, t.code, t.name;

UPDATE contract_template_versions v
SET status = 'SUPERSEDED', updated_at = now()
FROM _tmpl_next n
WHERE v.template_id = n.template_id
  AND v.status = 'ACTIVE'
  AND v.version < n.next_version;

INSERT INTO contract_template_versions (
  company_id, tenant_id, template_id, version, name, sections, content, status
)
SELECT n.company_id, n.tenant_id, n.template_id, n.next_version, n.name,
       s.sections, s.sections, 'ACTIVE'
FROM _tmpl_next n
JOIN (VALUES
  ('TMPL-PERM',
   '[{"section_code":"EMPLOYER","clauses":[]},
     {"section_code":"EMPLOYEE","clauses":[]},
     {"section_code":"EMPLOYMENT","clauses":["APPOINTMENT"]},
     {"section_code":"DUTIES","clauses":["DUTIES","OHS_COMMITTEE"]},
     {"section_code":"COMPENSATION","clauses":["SALARY","ALLOWANCES","OVERTIME"]},
     {"section_code":"WORKING_HOURS","clauses":["WORKING_HOURS"]},
     {"section_code":"LEAVE","clauses":["ANNUAL_LEAVE","SICK_LEAVE","MATERNITY_LEAVE","PATERNITY_LEAVE"]},
     {"section_code":"RIGHTS","clauses":["NON_DISCRIMINATION","EQUAL_PAY","SEXUAL_HARASSMENT","INTIMIDATION_HARASSMENT","FORCED_LABOUR_PROHIBITION","CHILD_LABOUR_PROHIBITION","PREGNANCY_PROTECTION"]},
     {"section_code":"CONFIDENTIALITY","clauses":["CONFIDENTIALITY","DATA_PROTECTION","INTELLECTUAL_PROPERTY","COMPANY_PROPERTY","IT_ACCEPTABLE_USE","IT_MONITORING","CYBERSECURITY","DATA_BREACH_REPORTING","CONFLICT_OF_INTEREST","ANTI_BRIBERY","ANTI_FRAUD","WORKPLACE_CONDUCT"]},
     {"section_code":"TERMINATION","clauses":["NOTICE","TERMINATION","REDUNDANCY","SEVERANCE_ALLOWANCE","TERMINAL_BENEFITS","CERTIFICATE_OF_SERVICE","DISCIPLINARY","GRIEVANCE","DISPUTE_RESOLUTION"]},
     {"section_code":"GENERAL","clauses":["GENERAL_PROVISIONS","GOVERNING_LAW","EMPLOYMENT_RECORDS"]},
     {"section_code":"SIGNATURES","clauses":[]}]'::jsonb),
  ('TMPL-FIXED',
   '[{"section_code":"EMPLOYER","clauses":[]},
     {"section_code":"EMPLOYEE","clauses":[]},
     {"section_code":"EMPLOYMENT","clauses":["APPOINTMENT","FIXED_TERM"]},
     {"section_code":"DUTIES","clauses":["DUTIES","OHS_COMMITTEE"]},
     {"section_code":"COMPENSATION","clauses":["SALARY","ALLOWANCES","OVERTIME"]},
     {"section_code":"WORKING_HOURS","clauses":["WORKING_HOURS"]},
     {"section_code":"LEAVE","clauses":["ANNUAL_LEAVE","SICK_LEAVE","MATERNITY_LEAVE","PATERNITY_LEAVE"]},
     {"section_code":"RIGHTS","clauses":["NON_DISCRIMINATION","EQUAL_PAY","SEXUAL_HARASSMENT","INTIMIDATION_HARASSMENT","FORCED_LABOUR_PROHIBITION","CHILD_LABOUR_PROHIBITION","PREGNANCY_PROTECTION"]},
     {"section_code":"CONFIDENTIALITY","clauses":["CONFIDENTIALITY","DATA_PROTECTION","INTELLECTUAL_PROPERTY","COMPANY_PROPERTY","IT_ACCEPTABLE_USE","CYBERSECURITY","DATA_BREACH_REPORTING","CONFLICT_OF_INTEREST","ANTI_BRIBERY","ANTI_FRAUD","WORKPLACE_CONDUCT"]},
     {"section_code":"TERMINATION","clauses":["NOTICE","TERMINATION","SEVERANCE_ALLOWANCE","TERMINAL_BENEFITS","CERTIFICATE_OF_SERVICE","DISCIPLINARY","GRIEVANCE","DISPUTE_RESOLUTION"]},
     {"section_code":"GENERAL","clauses":["GENERAL_PROVISIONS","GOVERNING_LAW","EMPLOYMENT_RECORDS"]},
     {"section_code":"SIGNATURES","clauses":[]}]'::jsonb),
  ('TMPL-PROB',
   '[{"section_code":"EMPLOYER","clauses":[]},
     {"section_code":"EMPLOYEE","clauses":[]},
     {"section_code":"EMPLOYMENT","clauses":["APPOINTMENT","PROBATION"]},
     {"section_code":"DUTIES","clauses":["DUTIES","OHS_COMMITTEE"]},
     {"section_code":"COMPENSATION","clauses":["SALARY","ALLOWANCES"]},
     {"section_code":"WORKING_HOURS","clauses":["WORKING_HOURS"]},
     {"section_code":"LEAVE","clauses":["ANNUAL_LEAVE","SICK_LEAVE"]},
     {"section_code":"CONFIDENTIALITY","clauses":["CONFIDENTIALITY","DATA_PROTECTION","COMPANY_PROPERTY","IT_ACCEPTABLE_USE","CYBERSECURITY","DATA_BREACH_REPORTING","WORKPLACE_CONDUCT"]},
     {"section_code":"TERMINATION","clauses":["NOTICE","TERMINATION","DISCIPLINARY","GRIEVANCE","DISPUTE_RESOLUTION"]},
     {"section_code":"GENERAL","clauses":["GENERAL_PROVISIONS","GOVERNING_LAW"]},
     {"section_code":"SIGNATURES","clauses":[]}]'::jsonb)
) AS s(code, sections) ON s.code = n.code;
