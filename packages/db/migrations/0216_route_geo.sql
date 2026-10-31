-- ============================================================================
-- 0216 - Route geography for the logistics map
--
-- A route is a straight shot from the factory to a delivery destination. To
-- draw it on a map and compute its distance/estimated time automatically we
-- need to keep the two endpoints' coordinates, not just their address text.
--
-- Origin is backfilled to the factory (Kyambogo) so every existing route at
-- least renders its starting point; destination coordinates are filled by the
-- map picker as destinations are chosen.
-- ============================================================================

ALTER TABLE routes ADD COLUMN origin_lat double precision;
ALTER TABLE routes ADD COLUMN origin_lng double precision;
ALTER TABLE routes ADD COLUMN destination_lat double precision;
ALTER TABLE routes ADD COLUMN destination_lng double precision;

-- Backfill the factory origin for every existing route: they all start at the
-- factory, so their origin endpoint is already known even before a map is opened.
UPDATE routes
   SET origin_lat = 0.3476,
       origin_lng = 32.6316
 WHERE origin_lat IS NULL;
