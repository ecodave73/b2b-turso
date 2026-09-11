/**
 * A browser-side MIRROR of the order state machine in src/api/services/orders.ts.
 *
 * Why a copy instead of an import: the server module pulls in the schema and the scoped guard,
 * so importing it here would drag server code into the browser bundle. The map is duplicated
 * deliberately and the SERVER REMAINS AUTHORITATIVE — `orders.updateStatus` re-checks every
 * transition and refuses illegal ones, so the worst a drift here can do is offer a button that
 * the server then rejects with a visible error. Keep the two in step.
 */
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

/** Legal next statuses for a status string that may not be one we know about. */
export function nextStatuses(status: string): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[status as OrderStatus] ?? [];
}
