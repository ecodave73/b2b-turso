import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { shippingRates } from "../database/schema";
import { authed, requireTenantId, tenantStaff } from "../middleware/auth";

/**
 * Shipping — the port of src/lib/services/shippingService.ts.
 *
 * WHAT THIS DOES NOT DO: fetch live carrier rates. The old service carried a
 * `TODO: Integrate AusPost and Sendle APIs here` and returned the tenant's manual fallback
 * table instead. That is ported as-is, TODO included — quoting a parcel returns the tenant's
 * own fallback rates, and no carrier is ever called. Anything that claims otherwise in the UI
 * would be lying to the buyer.
 *
 * RATES ARE CENTS (`rateCents`) and PARCEL WEIGHT IS GRAMS (`weightGrams`), per the schema
 * conventions. The old stack used dollars and kilograms; the parcel input below takes grams.
 *
 * Reads are open to every tenant role — a buyer needs a delivery quote at checkout. Writes are
 * back-office only.
 */

const parcelInput = z.object({
  weightGrams: z.number().int().min(0),
  lengthMm: z.number().int().min(0).optional(),
  widthMm: z.number().int().min(0).optional(),
  heightMm: z.number().int().min(0).optional(),
  originPostcode: z.string().trim().max(10).optional(),
  destinationPostcode: z.string().trim().max(10).optional(),
});

export const shipping = {
  /**
   * Quote for a parcel. Returns the tenant's fallback rates, cheapest first.
   *
   * The parcel dimensions are accepted and deliberately unused: they are what a live carrier
   * integration will need, and taking them now means the call site does not change when one
   * lands. `conditions` on a rate row is likewise not yet evaluated.
   */
  rates: authed.input(parcelInput).handler(async ({ input, context }) => {
    void input;

    const rows = await context.db.shippingRates.findMany({
      where: eq(shippingRates.isFallback, true),
      orderBy: asc(shippingRates.rateCents),
    });

    return rows.map((row) => ({
      id: row.id,
      carrier: row.carrier,
      serviceName: row.serviceName,
      rateCents: row.rateCents,
      estimatedDays: row.estimatedDays ?? "Contact us",
      isLive: false as const,
    }));
  }),

  /** Every rate the tenant has configured, fallback or not. */
  list: authed.handler(async ({ context }) => {
    const rows = await context.db.shippingRates.findMany({
      orderBy: [asc(shippingRates.carrier), asc(shippingRates.rateCents)],
    });

    return rows.map((row) => ({
      id: row.id,
      carrier: row.carrier,
      serviceName: row.serviceName,
      rateCents: row.rateCents,
      estimatedDays: row.estimatedDays,
      isFallback: row.isFallback,
      conditions: row.conditions ?? {},
    }));
  }),

  create: tenantStaff
    .input(
      z.object({
        carrier: z.string().trim().min(1).max(60),
        serviceName: z.string().trim().min(1).max(120),
        rateCents: z.number().int().min(0),
        estimatedDays: z.string().trim().max(60).nullish(),
        isFallback: z.boolean().default(false),
        conditions: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);

      const created = await context.db.shippingRates.insert({
        tenantId,
        carrier: input.carrier,
        serviceName: input.serviceName,
        rateCents: input.rateCents,
        estimatedDays: input.estimatedDays ?? null,
        isFallback: input.isFallback,
        conditions: input.conditions ?? {},
      });

      await context.db.activityLogs.insert({
        tenantId,
        userId: context.user.id,
        action: "shipping.rate_created",
        entity: "shipping",
        entityId: created.id,
        details: { carrier: input.carrier, serviceName: input.serviceName, rateCents: input.rateCents },
      });

      return { id: created.id };
    }),

  delete: tenantStaff.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const tenantId = requireTenantId(context.ctx);

    const removed = await context.db.shippingRates.deleteById(input.id);
    if (!removed) throw new ORPCError("NOT_FOUND", { message: "Shipping rate not found." });

    await context.db.activityLogs.insert({
      tenantId,
      userId: context.user.id,
      action: "shipping.rate_deleted",
      entity: "shipping",
      entityId: input.id,
      details: { carrier: removed.carrier, serviceName: removed.serviceName },
    });

    return { success: true };
  }),
};
