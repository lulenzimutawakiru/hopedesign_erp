-- Public site and mail-from identity: hopedesign.jorlentech.com
UPDATE companies
   SET website = 'https://hopedesign.jorlentech.com',
       email = CASE
         WHEN email ILIKE '%@hopedesign.co.ug' OR email ILIKE '%@hopedesign.ug'
           THEN replace(replace(email, '@hopedesign.co.ug', '@hopedesign.jorlentech.com'), '@hopedesign.ug', '@hopedesign.jorlentech.com')
         ELSE email
       END
 WHERE code = 'HDG';

UPDATE branches
   SET email = CASE
         WHEN email ILIKE '%@hopedesign.co.ug' OR email ILIKE '%@hopedesign.ug'
           THEN replace(replace(email, '@hopedesign.co.ug', '@hopedesign.jorlentech.com'), '@hopedesign.ug', '@hopedesign.jorlentech.com')
         ELSE email
       END
 WHERE email ILIKE '%hopedesign.co.ug' OR email ILIKE '%hopedesign.ug';

UPDATE app_settings
   SET value = '"https://hopedesign.jorlentech.com/verify"'
 WHERE key = 'qr_verify_url'
   AND value::text ILIKE '%hopedesign%';

UPDATE communication_settings
   SET value = jsonb_set(
         jsonb_set(value, '{sender}', '"notifications@hopedesign.jorlentech.com"'),
         '{host}', '"hopedesign.jorlentech.com"'
       )
 WHERE category = 'smtp' AND key = 'default';
