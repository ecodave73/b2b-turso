import { inArray } from "drizzle-orm";
import { z } from "zod";
import { orderLineItems } from "../database/schema";
import { requireTenantId, tenantStaff } from "../middleware/auth";
import { stockLevels } from "../services/inventory";
import { ORDER_STATUSES, type OrderStatus } from "../services/orders";

/**
 * Dashboard aggregates — new API, no direct equivalent in the old stack.
 *
 * The old dashboard page pulled `listProducts()` and `listOrders()` in full and did the maths
 * in the browser, which is why its "Low Stock Items" tile displayed the total product count:
 * the number was never computed. The aggregates now happen server-side so the tile can be
 * honest.
 *
 * LOW STOCK is defined here as an active product whose derived on-hand quantity is below its
 * MOQ — i.e. stock too thin to satisfy the smallest order the tenant will accept. There is no
 * reorder-threshold column in the schema (the old one had none either), so this is the most
 * defensible definition available without inventing a field. Documented in design.md.
 *
 * Gate: back-office only. Revenue and stock health are not buyer-facing, and the client
 * dashboard is built from the buyer's own orders and cart instead.
 *
 * Aggregation happens in TypeScript over the tenant's own rows because the scoped guard
 * exposes no aggregate beyond `count` — the same trade-off as services/inventory.ts. If the
 * volumes ever outgrow it, the fix is an aggregate method on the guard, not a raw client here.
 */

/** Orders still moving through the pipeline — anything not settled and not cancelled. */
const OPEN_STATUSES: readonly OrderStatus[] = ["DRAFT", "PENDING", "CONFIRMED", "SHIPPED", "INVOICED"];

/** Statuses that count as money actually earned. */
const EARNED_STATUSES: readonly OrderStatus[] = ["PAID", "CLOSED"];

export const dashboard = {
  stats: tenantStaff.handler(async ({ context }) => {
    requireTenantId(context.ctx);

    const [productRows, orderRows] = await Promise.all([
      context.db.products.findMany({}),
      context.db.orders.findMany({}),
    ]);

    const activeProducts = productRows.filter((product) => product.isActive);
    const levels = await stockLevels(
      context.db,
      activeProducts.map((product) => product.id),
    );

    const lowStock = activeProducts.filter((product) => (levels.get(product.id) ?? 0) < product.moq);

    const byStatus = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<
      OrderStatus,
      number
    >;
    for (const order of orderRows) {
      const status = order.status as OrderStatus;
      if (status in byStatus) byStatus[status] += 1;
    }

    const isOpen = (status: string) => OPEN_STATUSES.includes(status as OrderStatus);
    const isEarned = (status: string) => EARNED_STATUSES.includes(status as OrderStatus);

    const revenueCents = orderRows
      .filter((order) => isEarned(order.status))
      .reduce((sum, order) => sum + order.totalCents, 0);
    const openValueCents = orderRows
      .filter((order) => isOpen(order.status))
      .reduce((sum, order) => sum + order.totalCents, 0);

    const recent = [...orderRows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 5);

    const itemCounts = new Map<string, number>();
    if (recent.length > 0) {
      const lines = await context.db.orderLineItems.findMany({
        where: inArray(
          orderLineItems.orderId,
          recent.map((order) => order.id),
        ),
      });
      for (const line of lines) itemCounts.set(line.orderId, (itemCounts.get(line.orderId) ?? 0) + 1);
    }

    return {
      products: {
        total: productRows.length,
        active: activeProducts.length,
        lowStock: lowStock.length,
      },
      orders: {
        total: orderRows.length,
        open: orderRows.filter((order) => isOpen(order.status)).length,
        byStatus,
      },
      revenueCents,
      openValueCents,
      recentOrders: recent.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        totalCents: order.totalCents,
        currency: order.currency,
        itemCount: itemCounts.get(order.id) ?? 0,
        createdAt: order.createdAt,
      })),
    };
  }),

  /**
   * The products whose stock has fallen under their MOQ, worst first. Feeds the dashboard's
   * low-stock card and the inventory page's warning list.
   */
  lowStock: tenantStaff
    .input(z.object({ limit: z.number().int().min(1).max(100).default(10) }).prefault({}))
    .handler(async ({ input, context }) => {
      requireTenantId(context.ctx);

      const productRows = (await context.db.products.findMany({})).filter((product) => product.isActive);
      const levels = await stockLevels(
        context.db,
        productRows.map((product) => product.id),
      );

      return productRows
        .map((product) => ({
          id: product.id,
          sku: product.sku,
          name: product.name,
          moq: product.moq,
          stockOnHand: levels.get(product.id) ?? 0,
        }))
        .filter((product) => product.stockOnHand < product.moq)
        .sort((a, b) => a.stockOnHand - a.moq - (b.stockOnHand - b.moq))
        .slice(0, input.limit);
    }),
};
