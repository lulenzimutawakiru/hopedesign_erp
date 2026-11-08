/**
 * The product `type` values that may be sold — i.e. the factory's finished
 * goods. "Only finished goods are sold": reams, cut sheets, finished goods and
 * security paper. Raw materials (jumbo rolls, paper bobbins), packaging,
 * consumables and spares are procured and consumed, never sold.
 *
 * Single source of truth. The sales and CRM product pickers, the Inventory
 * "Products" catalogue (`resource: 'products'` in the route registry) and the
 * production-planning product list all filter on this same set so the notion of
 * "a sold product" can never drift apart between modules.
 */
export const SELLABLE_PRODUCT_TYPES: string[] = ['REAM', 'SHEET', 'FINISHED_GOODS', 'SECURITY_ITEM'];
