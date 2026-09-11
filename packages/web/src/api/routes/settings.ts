import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { requireTenantId, tenantAdmin, tenantStaff } from "../middleware/auth";

/**
 * Tenant settings — the tenant-profile half of the old settings page.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - plan / subscription: phase 6 (Stripe on the real SDK). A tenant must not be able to
 *     write its own plan column; that is what a checkout session is for.
 *   - isActive: a SUPER_ADMIN ops switch, never self-service, and never a billing signal
 *     (phase 6 adds a separate subscriptionStatus for that).
 *   - subdomain / customDomain: tenant addressing is wired at deploy through the resolver
 *     seam. Letting a tenant rename its own subdomain mid-flight would strand every URL and
 *     needs the reserved-word and availability checks that live in routes/signup.ts.
 *   - Square and Sanity credentials: deferred with their features.
 *
 * Gates follow the old procedures: reads are back-office (TENANT_ADMIN + TENANT_STAFF),
 * writes are TENANT_ADMIN only (the old branding update was ["TENANT_ADMIN", "SUPER_ADMIN"],
 * and SUPER_ADMIN passes every gate here).
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const settings = {
  get: tenantStaff.handler(async ({ context }) => {
    const tenantId = requireTenantId(context.ctx);

    const tenant = await context.db.tenants.findById(tenantId);
    if (!tenant) throw new ORPCError("NOT_FOUND", { message: "Tenant not found." });

    return {
      id: tenant.id,
      name: tenant.name,
      logo: tenant.logo,
      brandColor: tenant.brandColor,
      subdomain: tenant.subdomain,
      customDomain: tenant.customDomain,
      domainStatus: tenant.domainStatus,
      plan: tenant.plan,
      isActive: tenant.isActive,
      isSandbox: tenant.isSandbox,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
      /** True once billing is wired in phase 6; the UI must not imply a live subscription. */
      billingConnected: !!tenant.stripeSubscriptionId,
    };
  }),

  update: tenantAdmin
    .input(
      z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          logo: z.string().trim().max(2000).nullish(),
          brandColor: z
            .string()
            .trim()
            .regex(HEX_COLOR, "Brand colour must be a 6-digit hex value like #2260F6.")
            .optional(),
        })
        .refine((value) => Object.keys(value).length > 0, "Nothing to update."),
    )
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.logo !== undefined) patch.logo = input.logo ?? null;
      if (input.brandColor !== undefined) patch.brandColor = input.brandColor;

      const updated = await context.db.tenants.updateById(tenantId, patch);
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Tenant not found." });

      await context.db.activityLogs.insert({
        tenantId,
        userId: context.user.id,
        action: "tenant.settings_updated",
        entity: "tenant",
        entityId: tenantId,
        details: { fields: Object.keys(patch) },
      });

      return {
        id: updated.id,
        name: updated.name,
        logo: updated.logo,
        brandColor: updated.brandColor,
        updatedAt: updated.updatedAt,
      };
    }),
};
