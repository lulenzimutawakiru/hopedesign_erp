-- ============================================================================
-- 0217 - Allow a trip to exist before a vehicle is assigned
--
-- Dispatching a delivery note feeds the logistics module a Trip automatically
-- (services/logistics.ts syncTripForDelivery). The dispatch forms do not collect
-- a vehicle/driver, so the delivery note's vehicle_id is NULL at dispatch time,
-- and the feed inserts a trip with vehicle_id = NULL. `trips.vehicle_id` was
-- NOT NULL, so the insert raised a NOT NULL violation and rolled back the whole
-- dispatch transaction — no delivery note, no stock movement, no trip.
--
-- A trip is still a vehicle journey, but the vehicle can legitimately be chosen
-- a moment later in the logistics module (the driver_id column was already
-- nullable for the same reason). Making vehicle_id nullable lets the feed create
-- the trip with its customer, destination and route, leaving transport to be
-- assigned. fuel_logs / fleet_maintenance keep their NOT NULL: a fuel or service
-- record without a vehicle is meaningless.
-- ============================================================================

ALTER TABLE trips ALTER COLUMN vehicle_id DROP NOT NULL;
