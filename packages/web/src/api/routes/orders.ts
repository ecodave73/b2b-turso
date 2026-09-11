import { ORPCError } from "@orpc/server";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  companies,
  orderLineItems,
  orders as ordersTable,
  payments as paymentsTable,
  products,
} from "../database/schema";
import { authed, requireTenantId, tenantStaff } from "../middleware/auth";
import {
  assertProductsInScope,
  assertTransition,
  createOrderWithLines,
  ORDER_STATUSES,
} from "../services/orders";
import { effectivePrice, taxCents } from "../services/pricing";
import { withScopedTransaction } from "../tenant/guard";

/**
 * Orders — the port of src/lib/services/orderService.ts.
 *
 * The `orders` table is imported as `ordersTable` because this file must export `orders`
 * (konsistent `route-files-export-their-feature`) and the two names would otherwise collide.
 *
 * Role gating mirrors the old `requireRole` calls: any authenticated tenant user may create
 * and read their tenant's orders, only back-office roles may move an order through its
 * lifecycle. The state machine itself lives in ../services/orders.ts because checkout shares it.
 *
 * DELIBERATE DEVIATION from the old stack: line item prices are computed on the server from
 * the product and its volume tiers. The old `createOrder` accepted `unitPrice` from the
 * caller and wrote it straight to the line item, so a hand-rolled request could set its own
 * prices. MOQ and tier selection are now enforced on this path exactly as they are in the cart.
 */

const orderStatus = z.enum(ORDER_STATUSES);

export const orders = {
  /**
   * Creates a DRAFT order directly, bypassing the cart — the back-office "raise an order for
   * a customer" path. Cart checkout goes through cart.checkout and lands in PENDING.
   */
  create: authed
    .input(
      z.object({
        companyId: z.string().nullish(),
        poNumber: z.string().trim().max(120).nullish(),
        shippingAddress: z.string().trim().max(1000).nullish(),
        notes: z.string().trim().max(2000).nullish(),
        items: z
          .array(z.object({ productId: z.string(), quantity: z.number().int().min(1) }))
          .min(1)
          .max(200),
      }),
    )
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);

      await assertProductsInScope(
        context.db,
        input.items.map((item) => item.productId),
      );

      if (input.companyId) {
        const company = await context.db.companies.findById(input.companyId);
        if (!company) throw new ORPCError("BAD_REQUEST", { message: "Company not found." });
      }

      // Priced through the same function the cart and the quote endpoint use, so a customer
      // is never charged a price they were not shown. MOQ violations reject the whole order.
      const priced = await Promise.all(
        input.items.map(async (item) => {
          const price = await effectivePrice(context.db, item.productId, item.quantity, {
            requireActive: true,
          });
          return { ...price, taxCents: taxCents(price.totalPriceCents, price.taxRateBp) };
        }),
      );

      const subtotalCents = priced.reduce((sum, line) => sum + line.totalPriceCents, 0);
      const taxTotalCents = priced.reduce((sum, line) => sum + line.taxCents, 0);

      const order = await withScopedTransaction(context.ctx, async (tx) => {
        const created = await createOrderWithLines(tx, {
          tenantId,
          userId: context.user.id,
          status: "DRAFT",
          companyId: input.companyId ?? null,
          poNumber: input.poNumber ?? null,
          shippingAddress: input.shippingAddress ?? null,
          notes: input.notes ?? null,
          subtotalCents,
          taxTotalCents,
          totalCents: subtotalCents + taxTotalCents,
          lines: priced.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            totalPriceCents: line.totalPriceCents,
            metadata: { taxRateBp: line.taxRateBp, taxCents: line.taxCents },
          })),
        });

        await tx.activityLogs.insert({
          tenantId,
          userId: context.user.id,
          action: "order.created",
          entity: "order",
          entityId: created.id,
          details: { orderNumber: created.orderNumber, totalCents: created.totalCents },
        });

        return created;
      });

      return { id: order.id, orderNumber: order.orderNumber, totalCents: order.totalCents };
    }),

  list: authed
    .input(
      z
        .object({
          status: orderStatus.optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .prefault({}),
    )
    .handler(async ({ input, context }) => {
      const rows = await context.db.orders.findMany({
        where: input.status ? eq(ordersTable.status, input.status) : undefined,
        orderBy: desc(ordersTable.createdAt),
        limit: input.limit,
        offset: input.offset,
      });

      // The guard exposes no joins or aggregates, so the line item counts are one extra
      // scoped read and a tally in TypeScript rather than a `_count` include.
      const counts = new Map<string, number>();
      if (rows.length > 0) {
        const lines = await context.db.orderLineItems.findMany({
          where: inArray(
            orderLineItems.orderId,
            rows.map((row) => row.id),
          ),
        });
        for (const line of lines) counts.set(line.orderId, (counts.get(line.orderId) ?? 0) + 1);
      }

      return rows.map((row) => ({
        id: row.id,
        orderNumber: row.orderNumber,
        status: row.status,
        totalCents: row.totalCents,
        currency: row.currency,
        poNumber: row.poNumber,
        createdAt: row.createdAt,
        itemCount: counts.get(row.id) ?? 0,
      }));
    }),

  get: authed.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const order = await context.db.orders.findById(input.id);
    if (!order) throw new ORPCError("NOT_FOUND", { message: "Order not found." });

    const [lines, company, orderPayments] = await Promise.all([
      context.db.orderLineItems.findMany({ where: eq(orderLineItems.orderId, order.id) }),
      order.companyId ? context.db.companies.findById(order.companyId) : Promise.resolve(undefined),
      context.db.payments.findMany({
        where: eq(paymentsTable.orderId, order.id),
        orderBy: desc(paymentsTable.createdAt),
      }),
    ]);

    // Product names are denormalised onto the response, not the row: line items keep their
    // price snapshot, but the SKU and name a buyer sees should follow the current catalogue.
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const catalogue = new Map<string, { sku: string; name: string }>();
    if (productIds.length > 0) {
      const rows = await context.db.products.findMany({ where: inArray(products.id, productIds) });
      for (const row of rows) catalogue.set(row.id, { sku: row.sku, name: row.name });
    }

    return {
      ...order,
      company: company ? { id: company.id, name: company.name } : null,
      lineItems: lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        sku: catalogue.get(line.productId)?.sku ?? null,
        name: catalogue.get(line.productId)?.name ?? null,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        totalPriceCents: line.totalPriceCents,
        metadata: line.metadata ?? {},
      })),
      payments: orderPayments.map((payment) => ({
        id: payment.id,
        amountCents: payment.amountCents,
        method: payment.method,
        status: payment.status,
        reference: payment.reference,
        createdAt: payment.createdAt,
      })),
    };
  }),

  /** Moves an order through the lifecycle. Back-office only, and only along legal edges. */
  updateStatus: tenantStaff
    .input(z.object({ id: z.string(), status: orderStatus }))
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);

      const order = await context.db.orders.findById(input.id);
      if (!order) throw new ORPCError("NOT_FOUND", { message: "Order not found." });

      assertTransition(order.status, input.status);

      await context.db.orders.updateById(input.id, { status: input.status });

      await context.db.activityLogs.insert({
        tenantId,
        userId: context.user.id,
        action: "order.status_changed",
        entity: "order",
        entityId: input.id,
        details: { from: order.status, to: input.status },
      });

      return { id: input.id, status: input.status };
    }),

  /** The tenant's customer accounts — needed by the order form's company picker. */
  listCompanies: authed.handler(async ({ context }) => {
    const rows = await context.db.companies.findMany({ orderBy: asc(companies.name) });
    return rows.map((row) => ({ id: row.id, name: row.name, email: row.email }));
  }),
};
