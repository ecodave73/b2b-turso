import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { cartItems, carts, products } from "../database/schema";
import { authed, requireTenantId } from "../middleware/auth";
import { createOrderWithLines } from "../services/orders";
import { effectivePrice, taxCents } from "../services/pricing";
import { withScopedTransaction, type ScopedDb } from "../tenant/guard";

/**
 * Cart and checkout — the port of src/lib/services/cartService.ts.
 *
 * Every procedure here is `authed` with no role gate: buying is what a TENANT_CLIENT is for,
 * and staff buy through the same cart. A cart is keyed by (tenant, user), so a caller can only
 * ever reach their own — the guard scopes the tenant, the userId narrows it to the person.
 *
 * PRICES COME FROM ../services/pricing.ts, the same function the quote endpoint uses. The old
 * cartService kept a private copy that had already drifted from pricingService (it filtered
 * tiers by tenantId and required isActive; pricingService did neither), which meant the price
 * a buyer was quoted and the price they were charged came from two different implementations.
 *
 * MONEY IS CENTS and TAX IS BASIS POINTS. The old service computed tax as
 * `lineTotal * (taxRate / 100)` in floats; here it is integer basis points, rounded once per
 * line. Totals are therefore exact and always sum.
 */

/** Loads the caller's cart, creating it on first touch. */
async function getOrCreateCart(db: ScopedDb, tenantId: string, userId: string) {
  const existing = await db.carts.findFirst({ where: eq(carts.userId, userId) });
  if (existing) return existing;

  // The guard has no upsert, so this is find-then-insert. The unique index on
  // (tenantId, userId) is the real guarantee: a race loses the insert rather than
  // producing a second cart.
  try {
    return await db.carts.insert({ tenantId, userId });
  } catch (error) {
    const raced = await db.carts.findFirst({ where: eq(carts.userId, userId) });
    if (raced) return raced;
    throw error;
  }
}

interface CartLine {
  id: string;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  taxRateBp: number;
  taxCents: number;
  moq: number;
  image: string | null;
}

interface CartSummary {
  id: string;
  lines: CartLine[];
  itemCount: number;
  subtotalCents: number;
  taxTotalCents: number;
  shippingCostCents: number;
  totalCents: number;
  currency: "AUD";
}

/**
 * The cart as money. Inactive products are dropped from the total rather than blocking it —
 * a line that was archived after it was added should not strand the buyer at checkout.
 */
async function buildSummary(
  db: ScopedDb,
  tenantId: string,
  userId: string,
  shippingCostCents = 0,
): Promise<CartSummary> {
  const cart = await getOrCreateCart(db, tenantId, userId);

  const items = await db.cartItems.findMany({
    where: eq(cartItems.cartId, cart.id),
    orderBy: asc(cartItems.createdAt),
  });

  const productIds = [...new Set(items.map((item) => item.productId))];
  const catalogue = new Map<string, (typeof products)["$inferSelect"]>();
  if (productIds.length > 0) {
    const rows = await db.products.findMany({ where: inArray(products.id, productIds) });
    for (const row of rows) catalogue.set(row.id, row);
  }

  const lines: CartLine[] = [];
  for (const item of items) {
    const product = catalogue.get(item.productId);
    if (!product || !product.isActive) continue;

    const lineTotalCents = item.priceCents * item.quantity;
    lines.push({
      id: item.id,
      productId: item.productId,
      sku: product.sku,
      name: product.name,
      quantity: item.quantity,
      unitPriceCents: item.priceCents,
      lineTotalCents,
      taxRateBp: product.taxRateBp,
      taxCents: taxCents(lineTotalCents, product.taxRateBp),
      moq: product.moq,
      image: product.images?.[0] ?? null,
    });
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const taxTotalCents = lines.reduce((sum, line) => sum + line.taxCents, 0);

  return {
    id: cart.id,
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents,
    taxTotalCents,
    shippingCostCents,
    totalCents: subtotalCents + taxTotalCents + shippingCostCents,
    currency: "AUD",
  };
}

export const cart = {
  summary: authed
    .input(z.object({ shippingCostCents: z.number().int().min(0).default(0) }).prefault({}))
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);
      return buildSummary(context.db, tenantId, context.user.id, input.shippingCostCents);
    }),

  /**
   * Adds to the cart, re-pricing the COMBINED quantity — adding 40 to an existing 20 prices
   * all 60 at the 50+ tier, which is the behaviour a buyer expects and what the old service
   * did. MOQ is enforced against the combined quantity too.
   */
  addItem: authed
    .input(z.object({ productId: z.string(), quantity: z.number().int().min(1) }))
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);
      const cartRow = await getOrCreateCart(context.db, tenantId, context.user.id);

      const existing = await context.db.cartItems.findFirst({
        where: and(eq(cartItems.cartId, cartRow.id), eq(cartItems.productId, input.productId)),
      });

      const nextQuantity = (existing?.quantity ?? 0) + input.quantity;
      const price = await effectivePrice(context.db, input.productId, nextQuantity, { requireActive: true });

      const item = existing
        ? await context.db.cartItems.updateById(existing.id, {
            quantity: nextQuantity,
            priceCents: price.unitPriceCents,
          })
        : await context.db.cartItems.insert({
            cartId: cartRow.id,
            tenantId,
            productId: input.productId,
            quantity: input.quantity,
            priceCents: price.unitPriceCents,
          });

      if (!item) throw new ORPCError("NOT_FOUND", { message: "Cart item not found." });

      await context.db.activityLogs.insert({
        tenantId,
        userId: context.user.id,
        action: "cart.item_added",
        entity: "cart",
        entityId: cartRow.id,
        details: { productId: input.productId, quantity: input.quantity, nextQuantity },
      });

      return { id: item.id, quantity: item.quantity, unitPriceCents: item.priceCents };
    }),

  /** Quantity 0 removes the line, matching the old service. */
  updateItemQuantity: authed
    .input(z.object({ cartItemId: z.string(), quantity: z.number().int().min(0) }))
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);
      const cartRow = await getOrCreateCart(context.db, tenantId, context.user.id);

      const item = await context.db.cartItems.findFirst({
        where: and(eq(cartItems.id, input.cartItemId), eq(cartItems.cartId, cartRow.id)),
      });
      if (!item) throw new ORPCError("NOT_FOUND", { message: "Cart item not found." });

      if (input.quantity === 0) {
        await context.db.cartItems.deleteById(item.id);
        return { removed: true as const };
      }

      const price = await effectivePrice(context.db, item.productId, input.quantity, { requireActive: true });
      const updated = await context.db.cartItems.updateById(item.id, {
        quantity: input.quantity,
        priceCents: price.unitPriceCents,
      });
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Cart item not found." });

      return { removed: false as const, id: updated.id, quantity: updated.quantity, unitPriceCents: updated.priceCents };
    }),

  removeItem: authed.input(z.object({ cartItemId: z.string() })).handler(async ({ input, context }) => {
    const tenantId = requireTenantId(context.ctx);
    const cartRow = await getOrCreateCart(context.db, tenantId, context.user.id);

    const removed = await context.db.cartItems.delete(
      and(eq(cartItems.id, input.cartItemId), eq(cartItems.cartId, cartRow.id)),
    );
    if (removed.length === 0) throw new ORPCError("NOT_FOUND", { message: "Cart item not found." });

    return { success: true };
  }),

  clear: authed.handler(async ({ context }) => {
    const tenantId = requireTenantId(context.ctx);
    const cartRow = await getOrCreateCart(context.db, tenantId, context.user.id);
    await context.db.cartItems.delete(eq(cartItems.cartId, cartRow.id));
    return { success: true };
  }),

  /**
   * Turns the cart into a PENDING order and empties it.
   *
   * Runs inside `withScopedTransaction`, so the order, its line items, the emptied cart and
   * the audit entry all commit together. Without that, a failure between the order insert and
   * the cart delete leaves the buyer either double-charged or holding an order with no lines —
   * which is exactly why the old stack wrapped this in `withRlsTransaction`.
   *
   * Line item metadata snapshots sku, name and tax at the moment of purchase: the catalogue
   * can change afterwards, an invoice cannot.
   */
  checkout: authed
    .input(
      z
        .object({
          companyId: z.string().nullish(),
          poNumber: z.string().trim().max(120).nullish(),
          shippingAddress: z.string().trim().max(1000).nullish(),
          shippingMethod: z.string().trim().max(120).nullish(),
          shippingCostCents: z.number().int().min(0).default(0),
          notes: z.string().trim().max(2000).nullish(),
        })
        .prefault({}),
    )
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);
      const userId = context.user.id;

      const summary = await buildSummary(context.db, tenantId, userId, input.shippingCostCents);
      if (summary.lines.length === 0) throw new ORPCError("BAD_REQUEST", { message: "Cart is empty." });

      if (input.companyId) {
        const company = await context.db.companies.findById(input.companyId);
        if (!company) throw new ORPCError("BAD_REQUEST", { message: "Company not found." });
      }

      const order = await withScopedTransaction(context.ctx, async (tx) => {
        const created = await createOrderWithLines(tx, {
          tenantId,
          userId,
          status: "PENDING",
          companyId: input.companyId ?? null,
          poNumber: input.poNumber ?? null,
          shippingAddress: input.shippingAddress ?? null,
          shippingMethod: input.shippingMethod ?? null,
          shippingCostCents: input.shippingCostCents,
          subtotalCents: summary.subtotalCents,
          taxTotalCents: summary.taxTotalCents,
          totalCents: summary.totalCents,
          currency: summary.currency,
          notes: input.notes ?? null,
          lines: summary.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            totalPriceCents: line.lineTotalCents,
            metadata: {
              sku: line.sku,
              name: line.name,
              taxRateBp: line.taxRateBp,
              taxCents: line.taxCents,
            },
          })),
        });

        await tx.cartItems.delete(eq(cartItems.cartId, summary.id));

        await tx.activityLogs.insert({
          tenantId,
          userId,
          action: "cart.checked_out",
          entity: "order",
          entityId: created.id,
          details: {
            orderNumber: created.orderNumber,
            totalCents: created.totalCents,
            itemCount: summary.itemCount,
          },
        });

        return created;
      });

      return {
        id: order.id,
        orderNumber: order.orderNumber,
        totalCents: order.totalCents,
        status: order.status,
      };
    }),
};
