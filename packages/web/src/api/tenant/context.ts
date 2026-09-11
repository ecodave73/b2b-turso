import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request tenant context.
 *
 * This is the port of the old PostgreSQL session variables (`app.user_id`, `app.tenant_id`,
 * `app.user_role`) that RLS policies read via `current_setting()`. There is no database-side
 * enforcement any more — see ./guard.ts for what replaces it and how much weaker that is.
 */

export type Role = "SUPER_ADMIN" | "TENANT_ADMIN" | "TENANT_STAFF" | "TENANT_CLIENT";

export const ROLES: readonly Role[] = ["SUPER_ADMIN", "TENANT_ADMIN", "TENANT_STAFF", "TENANT_CLIENT"] as const;

export interface RequestContext {
  /** Authenticated platform user id, or null when anonymous. */
  userId: string | null;
  /** Resolved tenant id, or null when the request has no tenant yet (signup, host routing). */
  tenantId: string | null;
  role: Role;
}

/** The context an unauthenticated, unresolved request runs under. Sees nothing tenant-scoped. */
export const ANONYMOUS_CONTEXT: RequestContext = {
  userId: null,
  tenantId: null,
  role: "TENANT_CLIENT",
};

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `ctx` installed as the ambient request context.
 *
 * IMPORTANT — the lazy-promise hazard that bit the Prisma implementation:
 * an ORM query builder is lazy. If `fn` *returns a builder* rather than awaiting it, the
 * await happens after this scope has already exited and the ambient context is gone.
 * Two defences are in place:
 *   1. `fn` is typed to return a Promise, and every scoped helper in ./guard.ts is `async`
 *      and awaits internally, so no un-executed builder can escape.
 *   2. `scopedDb()` snapshots the context synchronously at call time, so even a stray
 *      deferred await is already bound to the right tenant.
 * Still write `async () => await ...`, not `() => db...`, at call sites.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** The ambient request context, or undefined outside a `runWithRequestContext` scope. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export class MissingRequestContextError extends Error {
  constructor() {
    super(
      "No tenant request context. Wrap the call in runWithRequestContext(ctx, async () => ...), " +
        "or pass the context explicitly to scopedDb(ctx).",
    );
    this.name = "MissingRequestContextError";
  }
}

/** The ambient request context. Throws rather than silently running unscoped. */
export function requireRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingRequestContextError();
  return ctx;
}

export function isSuperAdmin(ctx: RequestContext): boolean {
  return ctx.role === "SUPER_ADMIN";
}

/**
 * Is this a platform super admin looking at one tenant's data?
 *
 * A pure derivation off the context that is already built — no database read, no stored flag.
 * That is the whole of "open as tenant": a super admin who addresses a tenant's URL gets that
 * tenant scoped in by `withTenant`, and this is how the UI knows to say so. The old stack
 * instead repointed the admin's own user row, which made the state persistent across sessions
 * and devices with nothing on screen to indicate it.
 *
 * Note the role does NOT drop while viewing: the flag is derived FROM the role being
 * SUPER_ADMIN, so dropping it would erase the very thing that identifies the state.
 */
export function isViewingAsTenant(ctx: RequestContext): boolean {
  return isSuperAdmin(ctx) && !!ctx.tenantId;
}
