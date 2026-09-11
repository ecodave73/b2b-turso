import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { authed, requireTenantId, tenantStaff } from "../middleware/auth";
import { eventHistory, INVENTORY_EVENT_TYPES, stockLevel, stockLevels } from "../services/inventory";

/**
 * Inventory — the port of src/lib/services/inventoryService.ts.
 *
 * On-hand stock is DERIVED from the event log, never stored. Correcting a count means
 * appending an ADJUSTED event, so the history always explains the number.
 *
 * Role gating mirrors the old procedures: recording an event is back-office only; reading
 * stock and history is open to every tenant role, because a buyer needs to know whether the
 * thing they are ordering exists.
 */

const eventInput = z.object({
  productId: z.string(),
  eventType: z.enum(INVENTORY_EVENT_TYPES),
  /** Signed delta. Negative removes stock. Zero is meaningless and refused. */
  quantity: z.number().int().refine((value) => value !== 0, "Quantity must not be zero."),
  reference: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

export const inventory = {
  record: tenantStaff.input(eventInput).handler(async ({ input, context }) => {
    const tenantId = requireTenantId(context.ctx);

    // The guard scopes the write, but a product from another tenant would still be a valid
    // foreign key, so the reference is checked in scope before the event is appended.
    const productRow = await context.db.products.findById(input.productId);
    if (!productRow) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

    const created = await context.db.inventoryEvents.insert({
      tenantId,
      productId: input.productId,
      eventType: input.eventType,
      quantity: input.quantity,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdBy: context.user.id,
    });

    await context.db.activityLogs.insert({
      tenantId,
      userId: context.user.id,
      action: "inventory.event_recorded",
      entity: "inventory",
      entityId: input.productId,
      details: {
        eventType: input.eventType,
        quantity: input.quantity,
        reference: input.reference ?? null,
      },
    });

    return {
      id: created.id,
      productId: input.productId,
      stockOnHand: await stockLevel(context.db, input.productId),
    };
  }),

  stock: authed.input(z.object({ productId: z.string() })).handler(async ({ input, context }) => {
    const productRow = await context.db.products.findById(input.productId);
    if (!productRow) throw new ORPCError("NOT_FOUND", { message: "Product not found." });
    return { productId: input.productId, stockOnHand: await stockLevel(context.db, input.productId) };
  }),

  stockFor: authed
    .input(z.object({ productIds: z.array(z.string()).min(1).max(200) }))
    .handler(async ({ input, context }) => {
      const levels = await stockLevels(context.db, input.productIds);
      return input.productIds.map((productId) => ({ productId, stockOnHand: levels.get(productId) ?? 0 }));
    }),

  history: authed
    .input(z.object({ productId: z.string(), limit: z.number().int().min(1).max(200).default(20) }))
    .handler(async ({ input, context }) => {
      const productRow = await context.db.products.findById(input.productId);
      if (!productRow) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

      const events = await eventHistory(context.db, input.productId, input.limit);
      return events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        quantity: event.quantity,
        reference: event.reference,
        notes: event.notes,
        createdBy: event.createdBy,
        createdAt: event.createdAt,
      }));
    }),

  checkAvailability: authed
    .input(z.object({ productId: z.string(), quantity: z.number().int().min(1) }))
    .handler(async ({ input, context }) => {
      const productRow = await context.db.products.findById(input.productId);
      if (!productRow) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

      const onHand = await stockLevel(context.db, input.productId);
      return { productId: input.productId, stockOnHand: onHand, available: onHand >= input.quantity };
    }),
};
