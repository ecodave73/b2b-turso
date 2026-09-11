import { desc, eq, inArray } from "drizzle-orm";
import { inventoryEvents } from "../database/schema";
import type { ScopedDb } from "../tenant/guard";

/**
 * Event-sourced inventory — the port of the old src/lib/services/inventoryService.ts.
 *
 * THE RULE THAT MUST NOT BE BROKEN: on-hand quantity is DERIVED, never stored. It is the sum
 * of every event's signed delta. Nothing anywhere may write a stock column, because there
 * isn't one — correcting stock means appending an ADJUSTED event, which keeps the audit trail
 * intact and makes "why is this number wrong?" answerable.
 *
 * The old service used a Postgres `SUM()` aggregate. The scoped guard exposes no aggregate
 * beyond `count`, so the sum happens in TypeScript over the tenant's own events. That is fine
 * at the volumes this handles and keeps every read inside the guard; if it ever stops being
 * fine, the fix is an aggregate method on the guard, not a raw client here.
 */

export const INVENTORY_EVENT_TYPES = ["RECEIVED", "SOLD", "ADJUSTED", "RETURNED", "TRANSFERRED"] as const;
export type InventoryEventType = (typeof INVENTORY_EVENT_TYPES)[number];

/** On-hand quantity for one product. */
export async function stockLevel(db: ScopedDb, productId: string): Promise<number> {
  const events = await db.inventoryEvents.findMany({ where: eq(inventoryEvents.productId, productId) });
  return events.reduce((sum, event) => sum + event.quantity, 0);
}

/** On-hand quantity for many products at once, keyed by product id. Missing = 0. */
export async function stockLevels(db: ScopedDb, productIds: string[]): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  for (const id of productIds) levels.set(id, 0);
  if (productIds.length === 0) return levels;

  const events = await db.inventoryEvents.findMany({
    where: inArray(inventoryEvents.productId, productIds),
  });
  for (const event of events) {
    levels.set(event.productId, (levels.get(event.productId) ?? 0) + event.quantity);
  }
  return levels;
}

/** Most recent events for a product, newest first. */
export async function eventHistory(db: ScopedDb, productId: string, limit = 20) {
  return db.inventoryEvents.findMany({
    where: eq(inventoryEvents.productId, productId),
    orderBy: desc(inventoryEvents.createdAt),
    limit,
  });
}
