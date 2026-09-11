import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { authed } from "../middleware/auth";
import { PLANS } from "../services/platform";
import { eq, scopedDb } from "../tenant/guard";
import { isUsableSubdomain, RESERVED_SUBDOMAINS } from "../tenant/resolve";
import { tenants } from "../database/schema";

/**
 * Self-service tenant registration — the port of `selfRegisterTenant` in the old
 * src/api/procedures.ts, minus the Stripe leg.
 *
 * WHAT IS DELIBERATELY NOT HERE YET: the old flow created the tenant with `isActive: false`
 * and only flipped it on once a Stripe subscription was provisioned. Billing is phase 6, and
 * `withTenant` now refuses suspended tenants, so creating one inactive would lock the owner
 * out of their own account. Tenants are therefore created ACTIVE, and phase 6 has to add a
 * real onboarding state rather than reusing `isActive` as a payment gate.
 */


const subdomainInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Subdomain must be at least 3 characters.")
  .max(63, "Subdomain must be 63 characters or fewer.");

type Availability = { available: boolean; reason: string | null };

/** Shared by the live check and the create call, so the two can never disagree. */
async function subdomainAvailability(subdomain: string): Promise<Availability> {
  if (!isUsableSubdomain(subdomain)) {
    const reserved = RESERVED_SUBDOMAINS.has(subdomain);
    return {
      available: false,
      reason: reserved
        ? "That name is reserved by the platform."
        : "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number.",
    };
  }

  // No context is pinned, so `tenantSelfScope` is open and this can see every tenant — the
  // same openness host->tenant routing depends on. It reads one boolean and nothing else.
  const db = scopedDb({ userId: null, tenantId: null, role: "TENANT_CLIENT" });
  const existing = await db.tenants.findFirst({ where: eq(tenants.subdomain, subdomain) });

  return existing ? { available: false, reason: "That subdomain is already taken." } : { available: true, reason: null };
}

export const signup = {
  /** Live availability check for the registration form. */
  checkSubdomain: authed
    .input(z.object({ subdomain: subdomainInput }))
    .handler(({ input }): Promise<Availability> => subdomainAvailability(input.subdomain)),

  /**
   * Create a tenant and make the caller its TENANT_ADMIN.
   *
   * The caller has no tenant when this starts, so it runs in two contexts: the tenant row is
   * written from the caller's own (tenant-less) context, which `tenant_insert_policy` allows
   * for any authenticated user, and everything after it runs pinned to the new tenant — the
   * port of the old `setRequestTenant(tenant.id, "TENANT_ADMIN")` call.
   */
  createTenant: authed
    .input(
      z.object({
        companyName: z.string().trim().min(2).max(120),
        subdomain: subdomainInput,
        plan: z.enum(PLANS).default("starter"),
      }),
    )
    .handler(async ({ input, context }) => {
      if (context.ctx.tenantId) {
        throw new ORPCError("CONFLICT", { message: "This account already belongs to a tenant." });
      }

      const availability = await subdomainAvailability(input.subdomain);
      if (!availability.available) {
        throw new ORPCError("CONFLICT", { message: availability.reason ?? "That subdomain is unavailable." });
      }

      const tenant = await context.db.tenants.insert({
        name: input.companyName,
        subdomain: input.subdomain,
        plan: input.plan,
      });

      // From here the caller IS the tenant admin, so the writes below are in scope.
      const asAdmin = scopedDb({ userId: context.user.id, tenantId: tenant.id, role: "TENANT_ADMIN" });

      await asAdmin.users.updateById(context.user.id, { tenantId: tenant.id, role: "TENANT_ADMIN" });

      await asAdmin.activityLogs.insert({
        tenantId: tenant.id,
        userId: context.user.id,
        action: "tenant.created",
        entity: "tenant",
        entityId: tenant.id,
        details: { subdomain: tenant.subdomain, plan: tenant.plan, via: "self-service" },
      });

      return {
        tenantId: tenant.id,
        subdomain: tenant.subdomain,
        name: tenant.name,
        plan: tenant.plan,
      };
    }),
};
