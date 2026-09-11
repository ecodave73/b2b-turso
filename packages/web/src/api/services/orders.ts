import { ORPCError } from "@orpc/server";
import { inArray } from "drizzle-orm";
import { products } from "../database/schema";
import type { ScopedDb } from "../tenant/guard";

/**
 * Orders — the shared half of the port of src/lib/services/orderService.ts.
 *
 * Lives here rather than in the route because cart checkout creates orders too, and in the old
 * stack cartService kept its own duplicate of the order-number generator and its own inline
 * order insert. One implementation, used by both, so the two paths cannot drift.
 *
 * MONEY IS CENTS throughout. `subtotalCents`, `taxTotalCents`, `totalCents` are integers and
 * are computed by the caller — this module never re-derives a price, because an order is a
 * snapshot of what was quoted, not a live recalculation.
 */

/** The eight order states, copied verbatim from the old service. */
export const ORDER_STATUSES = [
  "DRAFT",
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "INVOICED",
  "PAID",
  "CLOSED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The legal transitions, copied verbatim from the old service. Do not "tidy" this table —
 * finance and fulfilment both depend on the exact shape, e.g. SHIPPED cannot be cancelled and
 * an INVOICED order can close without ever being marked PAID (that is how account-terms
 * customers settle).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["SHIPPED", "INVOICED", "CANCELLED"],
  SHIPPED: ["INVOICED"],
  INVOICED: ["PAID", "CLOSED"],
  PAID: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

/**
 * Refuses an illegal transition, naming what was allowed instead. The message matters: this
 * surfaces straight into the dashboard, and "cannot transition" with no list of alternatives
 * is the kind of error that generates a support ticket.
 */
export function assertTransition(from: string, to: OrderStatus): void {
  const allowed = ORDER_TRANSITIONS[from as OrderStatus] ?? [];
  if (!allowed.includes(to)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Cannot transition order from ${from} to ${to}. Allowed: ${allowed.join(", ") || "none"}.`,
    });
  }
}

/**
 * Human-readable order number: ORD-{YYMMDD}-{4 digits}, the old format exactly.
 *
 * The random suffix is not a uniqueness guarantee — `orders.orderNumber` carries a unique
 * index, so a collision surfaces as a failed insert rather than two orders sharing a number.
 */
export function generateOrderNumber(): string {
  const yymmdd = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${yymmdd}-${rand}`;
}

export interface OrderLineInput {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  metadata?: Record<string, unknown>;
}

export interface CreateOrderInput {
  tenantId: string;
  userId: string;
  status: OrderStatus;
  companyId?: string | null;
  poNumber?: string | null;
  shippingAddress?: string | null;
  shippingMethod?: string | null;
  shippingCostCents?: number;
  subtotalCents: number;
  taxTotalCents: number;
  totalCents: number;
  currency?: string;
  notes?: string | null;
  lines: OrderLineInput[];
}

/**
 * Verifies every product id is visible in the caller's scope.
 *
 * The guard stops a cross-tenant *read*, but a foreign key to another tenant's product is
 * still a valid foreign key, so an unchecked line item would silently attach one tenant's
 * catalogue to another's order. The old service ran the same check.
 */
export async function assertProductsInScope(db: ScopedDb, productIds: string[]): Promise<void> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return;

  const found = await db.products.findMany({ where: inArray(products.id, unique) });
  if (found.length !== unique.length) {
    throw new ORPCError("BAD_REQUEST", { message: "One or more products not found or not available." });
  }
}

/** Inserts the order and its line items. Call inside `withScopedTransaction` for atomicity. */
export async function createOrderWithLines(db: ScopedDb, input: CreateOrderInput) {
  const order = await db.orders.insert({
    tenantId: input.tenantId,
    orderNumber: generateOrderNumber(),
    companyId: input.companyId ?? null,
    userId: input.userId,
    status: input.status,
    poNumber: input.poNumber ?? null,
    shippingAddress: input.shippingAddress ?? null,
    shippingMethod: input.shippingMethod ?? null,
    shippingCostCents: input.shippingCostCents ?? 0,
    subtotalCents: input.subtotalCents,
    taxTotalCents: input.taxTotalCents,
    totalCents: input.totalCents,
    currency: input.currency ?? "AUD",
    notes: input.notes ?? null,
  });

  await db.orderLineItems.insertMany(
    input.lines.map((line) => ({
      orderId: order.id,
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      totalPriceCents: line.totalPriceCents,
      metadata: line.metadata ?? {},
    })),
  );

  return order;
}
