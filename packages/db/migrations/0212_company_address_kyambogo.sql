-- Hope Design Group's registered address moved from the Namanve placeholder to
-- Kyambogo. Update the seeded company/branch/customer/location rows so sales
-- documents stop printing the old "Plot 12, Namanve Industrial Park, Kampala"
-- address. Fresh seeds already carry the new value, so this only rewrites rows
-- that still hold the old one.
UPDATE companies
   SET address = 'Plot 59 Kyambogo Drive, Kyambogo'
 WHERE address IN ('Plot 12, Namanve Industrial Park, Kampala, Uganda',
                   'Plot 12, Namanve Industrial Park, Kampala');

UPDATE branches
   SET address = 'Plot 59 Kyambogo Drive, Kyambogo'
 WHERE address IN ('Plot 12, Namanve Industrial Park, Kampala, Uganda',
                   'Plot 12, Namanve Industrial Park, Kampala');

UPDATE customers
   SET address = 'Plot 59 Kyambogo Drive, Kyambogo'
 WHERE address IN ('Plot 12, Namanve Industrial Park, Kampala, Uganda',
                   'Plot 12, Namanve Industrial Park, Kampala');

UPDATE locations
   SET address = 'Plot 59 Kyambogo Drive, Kyambogo'
 WHERE address IN ('Plot 12, Namanve Industrial Park, Kampala, Uganda',
                   'Plot 12, Namanve Industrial Park, Kampala');
