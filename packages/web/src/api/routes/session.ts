import { withTenant } from "../middleware/auth";

/**
 * Who am I, and which tenant am I on?
 *
 * The one procedure the shell calls on every page load. It is deliberately on `withTenant`
 * rather than `authed`: an anonymous visitor on a tenant storefront still needs the tenant's
 * name and brand colour, and the signed-out dashboard needs to know it is signed out rather
 * than getting a 401 it has to interpret.
 */
export const session = {
  current: withTenant.handler(({ context }) => ({
    user: context.user,
    tenant: context.tenant,
    /**
     * "Open as tenant" — a platform super admin with a tenant scoped in. Derived in withTenant
     * from the role plus the resolved tenant, never stored, so there is no impersonation state
     * that can outlive the request or strand a session. The shell renders its banner off this
     * and nothing else, and exit is plain navigation back to the mothership.
     */
    isViewingAsTenant: context.viewingAsTenant,
    viewingTenant:
      context.viewingAsTenant && context.tenant
        ? { id: context.tenant.id, name: context.tenant.name, subdomain: context.tenant.subdomain }
        : null,
    /** Which addressing strategy found the tenant. Diagnostics for the deploy-time switch. */
    resolution: {
      source: context.tenantResolution.source,
      key: context.tenantResolution.key,
      /** A tenant was addressed but no such tenant exists — render a 404, not an empty app. */
      unknown: context.tenantResolution.unknown,
    },
  })),
};
