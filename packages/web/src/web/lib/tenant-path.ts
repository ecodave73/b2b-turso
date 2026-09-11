/**
 * Building a link INTO a tenant, from the mothership.
 *
 * The rule the rest of the app lives by is that nothing outside the resolution seam parses a
 * host or a pathname to work out which tenant is being addressed (src/api/tenant/resolve.ts on
 * the server, `tenantBase()` in app.tsx on the client, both allowlisted by `guard:verify`).
 * This helper does not break that rule: it never *reads* the current URL, it only *writes* one,
 * from the `subdomain` string the platform API returned on a tenant row.
 *
 * When real `{subdomain}.host` routing is switched on at deploy this is the one place that
 * changes — `tenantPath` starts returning an absolute `https://{sub}.{root}{path}` and every
 * caller keeps working, because they all already hand over a subdomain and a path.
 */
export const TENANT_PATH_PREFIX = "/t";

/** Where "Exit" from a tenant, and the mothership sidebar group, both point. */
export const MOTHERSHIP_HOME = "/admin";

export function tenantPath(subdomain: string, path = "/dashboard"): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${TENANT_PATH_PREFIX}/${subdomain}${suffix}`;
}
