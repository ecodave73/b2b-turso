import { ORPCError } from "@orpc/server";
import { base } from "../__core/app";
import { auth } from "../auth";
import {
  ANONYMOUS_CONTEXT,
  isViewingAsTenant,
  ROLES,
  runWithRequestContext,
  type RequestContext,
  type Role,
} from "../tenant/context";
import { scopedDb, type ScopedDb } from "../tenant/guard";
import {
  resolveTenant,
  resolveTenantById,
  TENANT_PATH_HEADER,
  type ResolvedTenant,
  type TenantResolution,
} from "../tenant/resolve";

/**
 * The procedure bases every feature builds on. This is where a Better Auth session becomes a
 * tenant `RequestContext`, and where that context is installed for the duration of the handler.
 *
 * The chain: base -> withUser -> withTenant -> authed -> role bases.
 *
 * TWO THINGS TO KNOW BEFORE WRITING A PROCEDURE
 *
 * 1. The guard isolates by TENANT, not by role. `context.db` is pre-filtered to the caller's
 *    tenant and nothing else — inside a tenant, a TENANT_CLIENT sees the same rows a
 *    TENANT_ADMIN does. Role enforcement is the procedure's job: pick the right base
 *    (`tenantStaff`, `tenantAdmin`, `superAdmin`) rather than assuming `context.db` will
 *    refuse. This is exactly how the old stack worked — RLS scoped the tenant, `requireRole`
 *    scoped the role — so it is not a regression, but it is easy to forget.
 *
 * 2. An ANONYMOUS request that addresses a tenant (storefront) gets that tenant's id in its
 *    context, so `context.db` will happily read its orders. Public procedures must therefore
 *    select storefront data explicitly. Never expose a whole table on `withTenant`.
 */

/** Better Auth stores `role` as free text; anything unrecognised falls back to the least privilege. */
function toRole(value: unknown): Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value) ? (value as Role) : "TENANT_CLIENT";
}

/** The session user, narrowed to the fields the app actually relies on. */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: Role;
  tenantId: string | null;
}

function toSessionUser(user: Record<string, unknown>): SessionUser {
  return {
    id: String(user.id),
    email: String(user.email ?? ""),
    name: (user.name as string | null) ?? null,
    image: (user.image as string | null) ?? null,
    role: toRole(user.role),
    tenantId: (user.tenantId as string | null) ?? null,
  };
}

/**
 * Optional auth. `context.user` is the session user or null.
 *
 * Nothing tenant-related happens here — see `withTenant`.
 */
export const withUser = base.use(async ({ context, next }) => {
  const session = await auth.api.getSession({ headers: context.headers });
  return next({
    context: {
      user: session?.user ? toSessionUser(session.user as unknown as Record<string, unknown>) : null,
      session: session?.session ?? null,
    },
  });
});

/**
 * Resolves the tenant, builds the `RequestContext`, and runs the whole downstream handler
 * inside `runWithRequestContext` so `scopedDb()` works anywhere below without threading the
 * context through by hand.
 *
 * Which tenant wins:
 *   - anonymous  -> the tenant the request addressed (storefront), or none
 *   - super admin -> the tenant the request addressed, else none (they are unscoped anyway)
 *   - everyone else -> THE TENANT ON THEIR OWN USER ROW, always. If the request addressed a
 *     different tenant, that is a cross-tenant attempt and the request is refused rather than
 *     quietly downgraded, so the failure is visible instead of looking like an empty account.
 *
 * `await next(...)` is deliberate, not noise: returning the promise unawaited would resolve
 * after the AsyncLocalStorage scope has already exited. See the note in tenant/context.ts.
 */
export const withTenant = withUser.use(async ({ context, next }) => {
  const resolution: TenantResolution = await resolveTenant({
    host: context.headers.get("host"),
    path: context.headers.get(TENANT_PATH_HEADER),
    headers: context.headers,
  });

  const user = context.user;
  let ctx: RequestContext;

  if (!user) {
    ctx = { ...ANONYMOUS_CONTEXT, tenantId: resolution.tenant?.id ?? null };
  } else if (user.role === "SUPER_ADMIN") {
    ctx = { userId: user.id, tenantId: resolution.tenant?.id ?? null, role: user.role };
  } else {
    if (resolution.tenant && user.tenantId && resolution.tenant.id !== user.tenantId) {
      throw new ORPCError("FORBIDDEN", {
        message: "This account does not belong to the tenant this request addressed.",
      });
    }
    ctx = { userId: user.id, tenantId: user.tenantId, role: user.role };
  }

  // The tenant the context actually points at — the addressed one when they agree, otherwise
  // the user's own, loaded so suspension and branding are known either way.
  let tenant: ResolvedTenant | null = null;
  if (ctx.tenantId) {
    tenant = resolution.tenant?.id === ctx.tenantId ? resolution.tenant : await resolveTenantById(ctx.tenantId);
  }

  // DELIBERATE DEVIATION from the old stack, which never checked this: a suspended tenant
  // could keep transacting, and `setTenantActive` only changed a number on the mothership
  // dashboard. Suspension now actually cuts access. Super admins are exempt so they can still
  // inspect and reactivate. Note for phase 6: tenants must be created ACTIVE, or a new owner
  // is locked out of their own onboarding.
  if (tenant && !tenant.isActive && ctx.role !== "SUPER_ADMIN") {
    throw new ORPCError("FORBIDDEN", { message: "This account is suspended. Contact support." });
  }

  const db: ScopedDb = scopedDb(ctx);

  // "Open as tenant", derived rather than stored: a super admin with a tenant scoped in is
  // viewing someone's workspace. No extra query, no impersonation row, nothing to unwind on
  // exit — navigating away is the exit.
  const viewingAsTenant = isViewingAsTenant(ctx);

  return runWithRequestContext(ctx, async () =>
    next({ context: { ctx, db, tenant, tenantResolution: resolution, viewingAsTenant } }),
  );
});

/** Protected procedures — rejects anonymous calls; `context.user` is non-null. */
export const authed = withTenant.use(async ({ context, next }) => {
  if (!context.user) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { user: context.user } });
});

/**
 * Role gate. A SUPER_ADMIN passes every gate, mirroring the old `requireRole`, which returned
 * early for super admins before checking the allow-list.
 */
export function requireRoles(...allowed: Role[]) {
  return authed.use(async ({ context, next }) => {
    if (context.ctx.role !== "SUPER_ADMIN" && !allowed.includes(context.ctx.role)) {
      throw new ORPCError("FORBIDDEN", {
        message: `Requires one of [${allowed.join(", ")}]; this account is ${context.ctx.role}.`,
      });
    }
    return next();
  });
}

/** Tenant owners and the platform. */
export const tenantAdmin = requireRoles("TENANT_ADMIN");

/** Anyone who works inside the tenant — the back-office surfaces. */
export const tenantStaff = requireRoles("TENANT_ADMIN", "TENANT_STAFF");

/** The mothership. No super-admin bypass to hand out here — this IS the bypass. */
export const superAdmin = authed.use(async ({ context, next }) => {
  if (context.ctx.role !== "SUPER_ADMIN") {
    throw new ORPCError("FORBIDDEN", { message: "Platform administrators only." });
  }
  return next();
});

/**
 * For procedures that cannot run without a tenant. A super admin who has not addressed one
 * lands here, which is intended: they must say which tenant they mean.
 */
export function requireTenantId(ctx: RequestContext): string {
  if (!ctx.tenantId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "No tenant for this request. Address one by subdomain, or join a tenant first.",
    });
  }
  return ctx.tenantId;
}
