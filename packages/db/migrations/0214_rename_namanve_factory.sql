-- The factory moved to the Kyambogo site, so the "Namanve Factory" name and
-- code no longer apply. Rename the seeded factory location (and any matching
-- branch) to Kyambogo.
UPDATE locations
   SET code = 'KYAMBOGO-FACTORY', name = 'Kyambogo Factory'
 WHERE code = 'NAMANVE-FACTORY' OR name = 'Namanve Factory';

UPDATE branches
   SET code = 'KYAMBOGO-FACTORY', name = 'Kyambogo Factory'
 WHERE code = 'NAMANVE-FACTORY' OR name = 'Namanve Factory';
