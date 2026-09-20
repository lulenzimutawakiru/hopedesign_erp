import type { MeUser } from './auth';
import { itemVisible } from './nav';

/** Navigation visibility is a UX affordance only; the API remains authoritative. */
export function mayOpen(user: MeUser | null, perm: string, module: string): boolean {
  return itemVisible(user, { perm, module });
}

/**
 * Resolve a QR entity type to a route the signed-in user can actually open.
 * Types with no known destination stay plain text rather than dead links.
 */
export function entityHref(user: MeUser | null, entityType: unknown, entityId: unknown): string | null {
  const type = String(entityType ?? '').trim().toUpperCase();
  const raw = entityId === null || entityId === undefined ? '' : String(entityId);
  if (!type || !raw || raw === '0') return null;
  const id = encodeURIComponent(raw);
  switch (type) {
    case 'PRODUCT':
      return mayOpen(user, 'inventory.items.view', 'inventory') ? '/inventory/items/' + id : null;
    case 'RAW_MATERIAL':
      return mayOpen(user, 'inventory.items.view', 'inventory') ? '/inventory/materials/' + id : null;
    case 'CONSUMABLE':
      return mayOpen(user, 'inventory.items.view', 'inventory') ? '/inventory/consumables/' + id : null;
    case 'BATCH': {
      const canTrace =
        mayOpen(user, 'inventory.stock.view', 'inventory') &&
        mayOpen(user, 'inventory.traceability.view', 'inventory');
      if (canTrace) return '/inventory-intel/trace/' + id;
      return mayOpen(user, 'inventory.batches.view', 'inventory') ? '/records/inventory/batches/' + id : null;
    }
    case 'WORK_ORDER':
      return mayOpen(user, 'production.work_orders.view', 'production') ? '/records/production/work_orders/' + id : null;
    case 'MACHINE':
      return mayOpen(user, 'production.machines.view', 'production') ? '/records/production/machines/' + id : null;
    case 'ASSET':
      return mayOpen(user, 'assets.register.view', 'assets') ? '/records/assets/register/' + id : null;
    case 'CUSTOMER':
      return mayOpen(user, 'crm.customers.view', 'crm') ? '/crm/customers/' + id : null;
    case 'BIN':
      return mayOpen(user, 'inventory.bins.view', 'inventory') ? '/records/inventory/bins/' + id : null;
    case 'SECURITY_JOB':
      return mayOpen(user, 'security_printing.jobs.view', 'security_printing') ? '/security-jobs' : null;
    case 'REAM':
    case 'CARTON':
      return mayOpen(user, 'qr.packing.scan', 'security_printing') ? '/packing' : null;
    default:
      return null;
  }
}

/**
 * Primary record behind a scanned QR.
 * Codes issued for a product rather than a specific entity carry only product_id,
 * so fall back to the product reference instead of dropping the destination.
 */
export function qrRecordHref(
  user: MeUser | null,
  qr: { entityType?: unknown; entityId?: unknown; productId?: unknown } | null | undefined
): string | null {
  if (!qr) return null;
  return entityHref(user, qr.entityType, qr.entityId) ?? entityHref(user, 'PRODUCT', qr.productId);
}
