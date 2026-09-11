import { ORPCError } from "@orpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { priceTiers } from "../database/schema";
import { authed, requireTenantId, tenantStaff } from "../middleware/auth";
import { effectivePrice, taxCents } from "../services/pricing";

/**
 * Volume pricing — the port of src/lib/services/pricingService.ts.
 *
 * The quote maths itself lives in ../services/pricing.ts because the cart needs exactly the
 * same function; in the old stack cartService kept a second, already-drifted copy.
 *
 * Reads are open to every tenant role (a buyer must see their own price breaks), writes are
 * back-office only — the same split the old `requireRole` calls had.
 */

export const pricing = {
  /** What one quantity of one product actually costs, tier applied and MOQ enforced. */
  quote: authed
    .input(z.object({ productId: z.string(), quantity: z.number().int().min(1) }))
    .handler(async ({ input, context }) => {
      const price = await effectivePrice(context.db, input.productId, input.quantity);
      const tax = taxCents(price.totalPriceCents, price.taxRateBp);
      return {
        ...price,
        taxCents: tax,
        totalIncTaxCents: price.totalPriceCents + tax,
      };
    }),

  tiers: authed.input(z.object({ productId: z.string() })).handler(async ({ input, context }) => {
    const productRow = await context.db.products.findById(input.productId);
    if (!productRow) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

    const rows = await context.db.priceTiers.findMany({
      where: eq(priceTiers.productId, input.productId),
      orderBy: asc(priceTiers.minQty),
    });

    return rows.map((tier) => ({
      id: tier.id,
      minQty: tier.minQty,
      maxQty: tier.maxQty,
      unitPriceCents: tier.unitPriceCents,
    }));
  }),

  createTier: tenantStaff
    .input(
      z
        .object({
          productId: z.string(),
          minQty: z.number().int().min(1),
          maxQty: z.number().int().min(1).nullish(),
          unitPriceCents: z.number().int().min(0),
        })
        .refine((value) => value.maxQty == null || value.maxQty >= value.minQty, {
          message: "maxQty must be greater than or equal to minQty.",
          path: ["maxQty"],
        }),
    )
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);

      const productRow = await context.db.products.findById(input.productId);
      if (!productRow) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

      // Overlapping tiers make the "deepest tier wins" rule ambiguous, so they are refused at
      // write time rather than silently resolved at read time. The old stack allowed overlaps
      // and let `orderBy minQty desc` pick a winner, which meant a typo quietly changed prices.
      const existing = await context.db.priceTiers.findMany({
        where: eq(priceTiers.productId, input.productId),
      });
      const newMax = input.maxQty ?? Number.MAX_SAFE_INTEGER;
      const overlap = existing.find((tier) => {
        const tierMax = tier.maxQty ?? Number.MAX_SAFE_INTEGER;
        return input.minQty <= tierMax && tier.minQty <= newMax;
      });
      if (overlap) {
        throw new ORPCError("CONFLICT", {
          message: `Overlaps the existing ${overlap.minQty}–${overlap.maxQty ?? "∞"} tier.`,
        });
      }

      const created = await context.db.priceTiers.insert({
        tenantId,
        productId: input.productId,
        minQty: input.minQty,
        maxQty: input.maxQty ?? null,
        unitPriceCents: input.unitPriceCents,
      });

      await context.db.activityLogs.insert({
        tenantId,
        userId: context.user.id,
        action: "pricing.tier_created",
        entity: "product",
        entityId: input.productId,
        details: { minQty: input.minQty, maxQty: input.maxQty ?? null, unitPriceCents: input.unitPriceCents },
      });

      return { id: created.id };
    }),

  deleteTier: tenantStaff.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const tenantId = requireTenantId(context.ctx);

    const removed = await context.db.priceTiers.delete(and(eq(priceTiers.id, input.id)));
    if (removed.length === 0) throw new ORPCError("NOT_FOUND", { message: "Price tier not found." });

    await context.db.activityLogs.insert({
      tenantId,
      userId: context.user.id,
      action: "pricing.tier_deleted",
      entity: "product",
      entityId: removed[0].productId,
      details: { minQty: removed[0].minQty, maxQty: removed[0].maxQty },
    });

    return { success: true };
  }),
};
