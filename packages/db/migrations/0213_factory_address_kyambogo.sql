-- The factory sits on the same Kyambogo site as the registered office, so the
-- seeded factory location and production facility no longer read
-- "Namanve Industrial Park, Kampala".
UPDATE locations
   SET address = 'Plot 59 Kyambogo Drive, Kyambogo'
 WHERE address = 'Namanve Industrial Park, Kampala';

UPDATE production_facilities
   SET address = 'Plot 59 Kyambogo Drive, Kyambogo'
 WHERE address = 'Namanve Industrial Park, Kampala';
