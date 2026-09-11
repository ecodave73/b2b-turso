import { tenants } from "../database/schema";
import { ANONYMOUS_CONTEXT } from "./context";
import { and, eq, scopedDb } from "./guard";

/**
 * THE TENANT RESOLUTION SEAM.
 *
 * Everything that needs to know "which tenant is this request for?" goes through
 * `resolveTenant`. Nothing else in the app parses a Host header or a URL for a tenant. That is
 * the whole point: today the managed preview URL has no wildcard DNS, so the real
 * `{subdomain}.host` strategy cannot be exercised, and we run on a path prefix plus a dev
 * header instead. At deploy, `TENANT_ROOT_DOMAIN` is set, the host strategy starts matching,
 * and no route, service or component changes.
 *
 * Strategy order is deliberate — most authoritative first:
 *   1. custom domain   — exact match on `tenants.customDomain` (a tenant's own vanity domain)
 *   2. subdomain       — `{subdomain}.TENANT_ROOT_DOMAIN`; inert until that env var is set
 *   3. path prefix     — `/t/{subdomain}/...`; the fallback the preview URL actually uses
 *   4. dev header      — `x-tenant-subdomain`; ONLY when TENANT_DEV_HEADER=1
 *
 * The dev header is a deliberate tenant-spoofing switch. It must never be enabled in
 * production — see `devHeaderEnabled()`. It exists so tests and local tooling can address a
 * tenant without DNS.
 *
 * Resolution runs BEFORE any request context exists, so the lookup uses ANONYMOUS_CONTEXT. The
 * guard's `tenantSelfScope` is open while no tenant is pinned precisely so host->tenant routing
 * can work; see guard.ts. It reads nothing but the tenants table.
 */

export type TenantSource = "custom-domain" | "subdomain" | "path-prefix" | "dev-header" | "none";

/** The subset of the tenant row the rest of the request is allowed to rely on. */
export interface ResolvedTenant {
  id: string;
  subdomain: string;
  name: string;
  plan: string;
  brandColor: string;
  isActive: boolean;
}

export interface TenantResolution {
  tenant: ResolvedTenant | null;
  /** Which strategy produced the candidate — "none" when nothing matched. */
  source: TenantSource;
  /** The key that was looked up (subdomain or host), for diagnostics and error messages. */
  key: string | null;
  /** True when a strategy produced a key but no tenant row matched it. */
  unknown: boolean;
}

export interface ResolveTenantInput {
  /** Host header, may include a port. */
  host?: string | null;
  /** Request pathname, e.g. "/t/acme/dashboard". */
  path?: string | null;
  headers?: Headers;
}

export const NO_TENANT: TenantResolution = { tenant: null, source: "none", key: null, unknown: false };

/** Path prefix that addresses a tenant when there is no wildcard DNS. */
export const TENANT_PATH_PREFIX = "/t";

/** Header that addresses a tenant in dev/test. Never trusted in production. */
export const TENANT_DEV_HEADER = "x-tenant-subdomain";

/**
 * Header carrying the browser's pathname on RPC calls.
 *
 * Every oRPC request goes to `/api/rpc/...`, so the server can never see `/t/acme/dashboard`
 * on its own — the path-prefix strategy is useless without the client forwarding it. The typed
 * client sets this header from `window.location.pathname`.
 *
 * It is client-controlled, and so is the URL it mirrors, so it grants nothing: an
 * authenticated non-super-admin's effective tenant always comes from their own user row, never
 * from the request (see middleware/auth.ts). Tenant addressing only selects which tenant an
 * ANONYMOUS storefront request reads, and which tenant a super admin is looking at.
 */
export const TENANT_PATH_HEADER = "x-tenant-path";

/**
 * Subdomains that are platform surfaces, not tenants. A tenant must never be able to register
 * one of these, or it would shadow the mothership or the marketing site.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www",
  "app",
  "api",
  "admin",
  "auth",
  "static",
  "assets",
  "cdn",
  "mail",
  "localhost",
]);

const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A syntactically valid, non-reserved tenant subdomain. */
export function isUsableSubdomain(value: string): boolean {
  const key = value.toLowerCase();
  return SUBDOMAIN_PATTERN.test(key) && !RESERVED_SUBDOMAINS.has(key);
}

function rootDomain(): string | null {
  const value = process.env.TENANT_ROOT_DOMAIN?.trim().toLowerCase();
  return value && value.length > 0 ? value : null;
}

/**
 * The dev header is only honoured when explicitly switched on. Anything other than an exact
 * "1" leaves it off, so a stray truthy value in a production env cannot open it.
 */
function devHeaderEnabled(): boolean {
  return process.env.TENANT_DEV_HEADER === "1";
}

function stripPort(host: string): string {
  // IPv6 literals arrive bracketed ("[::1]:4200"); everything after the bracket is the port.
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1).toLowerCase();
  const colon = host.lastIndexOf(":");
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

/** `{subdomain}.rootDomain` -> subdomain. Null for the apex, a mismatch, or a reserved name. */
export function subdomainFromHost(host: string | null | undefined, root: string | null = rootDomain()): string | null {
  if (!host || !root) return null;
  const clean = stripPort(host);
  if (clean === root) return null;
  const suffix = `.${root}`;
  if (!clean.endsWith(suffix)) return null;
  const label = clean.slice(0, -suffix.length);
  // Only a single label. "a.b.root" is not a tenant — it is a misconfiguration.
  if (label.includes(".")) return null;
  return isUsableSubdomain(label) ? label : null;
}

/** `/t/{subdomain}/rest` -> subdomain. Null when the path is not tenant-prefixed. */
export function subdomainFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2 || `/${segments[0]}` !== TENANT_PATH_PREFIX) return null;
  const label = segments[1]!.toLowerCase();
  return isUsableSubdomain(label) ? label : null;
}

/** Removes a `/t/{subdomain}` prefix so downstream routing sees the canonical path. */
export function stripTenantPathPrefix(path: string): string {
  if (!subdomainFromPath(path)) return path;
  const segments = path.split("/").filter(Boolean);
  const rest = segments.slice(2).join("/");
  return `/${rest}`;
}

interface Candidate {
  key: string;
  source: TenantSource;
  /** Custom domains match a different column. */
  by: "subdomain" | "customDomain";
}

/** Runs the strategies in priority order and returns the first candidate, without querying. */
export function pickTenantCandidate(input: ResolveTenantInput): Candidate | null {
  const host = input.host ?? input.headers?.get("host") ?? null;
  const root = rootDomain();

  if (host) {
    const clean = stripPort(host);
    // A host that is the root domain, or a subdomain of it, is never a custom domain.
    const isPlatformHost = root !== null && (clean === root || clean.endsWith(`.${root}`));
    if (!isPlatformHost && clean.includes(".") && !clean.startsWith("[")) {
      return { key: clean, source: "custom-domain", by: "customDomain" };
    }
  }

  const fromHost = subdomainFromHost(host, root);
  if (fromHost) return { key: fromHost, source: "subdomain", by: "subdomain" };

  const fromPath = subdomainFromPath(input.path);
  if (fromPath) return { key: fromPath, source: "path-prefix", by: "subdomain" };

  if (devHeaderEnabled()) {
    const header = input.headers?.get(TENANT_DEV_HEADER)?.trim().toLowerCase();
    if (header && isUsableSubdomain(header)) {
      return { key: header, source: "dev-header", by: "subdomain" };
    }
  }

  return null;
}

/**
 * Resolve the tenant for a request. Returns `NO_TENANT` when no strategy produced a candidate
 * (the platform surfaces — signup, the mothership — legitimately have no tenant), and a
 * resolution with `unknown: true` when a candidate was produced but matched no row.
 *
 * A suspended tenant (`isActive: false`) still resolves. Deciding what to do about that is the
 * caller's job — the mothership must be able to look at a tenant it has suspended.
 */
export async function resolveTenant(input: ResolveTenantInput): Promise<TenantResolution> {
  const candidate = pickTenantCandidate(input);
  if (!candidate) return NO_TENANT;

  const db = scopedDb(ANONYMOUS_CONTEXT);
  const where =
    candidate.by === "customDomain"
      ? and(eq(tenants.customDomain, candidate.key), eq(tenants.domainStatus, "active"))
      : eq(tenants.subdomain, candidate.key);

  const row = await db.tenants.findFirst({ where });
  if (!row) return { tenant: null, source: candidate.source, key: candidate.key, unknown: true };

  return {
    tenant: {
      id: row.id,
      subdomain: row.subdomain,
      name: row.name,
      plan: row.plan,
      brandColor: row.brandColor,
      isActive: row.isActive,
    },
    source: candidate.source,
    key: candidate.key,
    unknown: false,
  };
}

/**
 * Load a tenant by id, for the case where the request addressed no tenant but the
 * authenticated user belongs to one. Kept here so the tenants table is still only read
 * through this seam.
 *
 * Runs pinned to that tenant, so `tenantSelfScope` narrows to exactly that row.
 */
export async function resolveTenantById(id: string): Promise<ResolvedTenant | null> {
  const db = scopedDb({ userId: null, tenantId: id, role: "TENANT_CLIENT" });
  const row = await db.tenants.findById(id);
  if (!row) return null;
  return {
    id: row.id,
    subdomain: row.subdomain,
    name: row.name,
    plan: row.plan,
    brandColor: row.brandColor,
    isActive: row.isActive,
  };
}
