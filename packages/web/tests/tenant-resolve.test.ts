import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tenants } from "../src/api/database/schema";
import {
  isUsableSubdomain,
  pickTenantCandidate,
  RESERVED_SUBDOMAINS,
  resolveTenant,
  resolveTenantById,
  stripTenantPathPrefix,
  subdomainFromHost,
  subdomainFromPath,
  TENANT_DEV_HEADER,
} from "../src/api/tenant/resolve";
import { moduleDb, resetModuleDb } from "./helpers/module-db";

/**
 * The tenant-resolution seam (phase 2).
 *
 * The strategy that will actually run in production — `{subdomain}.TENANT_ROOT_DOMAIN` — is
 * inert today because the preview URL has no wildcard DNS. These tests exercise it anyway, by
 * setting the env var, so the deploy-time switch is covered before it is flipped rather than
 * after. That is the entire justification for the seam existing.
 */

const ROOT = "TENANT_ROOT_DOMAIN";
const DEV = "TENANT_DEV_HEADER";

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const savedRoot = process.env[ROOT];
const savedDev = process.env[DEV];

beforeEach(() => {
  delete process.env[ROOT];
  delete process.env[DEV];
});

afterEach(() => {
  setEnv(ROOT, savedRoot);
  setEnv(DEV, savedDev);
});

describe("isUsableSubdomain", () => {
  test("accepts ordinary labels", () => {
    expect(isUsableSubdomain("alpha")).toBe(true);
    expect(isUsableSubdomain("alpha-supply-co")).toBe(true);
    expect(isUsableSubdomain("a1")).toBe(true);
  });

  test("rejects labels that are not DNS-safe", () => {
    expect(isUsableSubdomain("-alpha")).toBe(false);
    expect(isUsableSubdomain("alpha-")).toBe(false);
    expect(isUsableSubdomain("al pha")).toBe(false);
    expect(isUsableSubdomain("alpha.beta")).toBe(false);
    expect(isUsableSubdomain("")).toBe(false);
    expect(isUsableSubdomain("x".repeat(64))).toBe(false);
  });

  /** A tenant on one of these would shadow the mothership or the marketing site. */
  test("rejects every reserved platform subdomain", () => {
    for (const reserved of RESERVED_SUBDOMAINS) {
      expect(isUsableSubdomain(reserved)).toBe(false);
    }
    expect(RESERVED_SUBDOMAINS.has("admin")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isUsableSubdomain("ALPHA")).toBe(true);
    expect(isUsableSubdomain("ADMIN")).toBe(false);
  });
});

describe("subdomainFromHost", () => {
  test("returns null while TENANT_ROOT_DOMAIN is unset — the strategy is inert until deploy", () => {
    expect(subdomainFromHost("alpha.example.com")).toBeNull();
  });

  test("extracts the label once the root domain is configured", () => {
    process.env[ROOT] = "example.com";
    expect(subdomainFromHost("alpha.example.com")).toBe("alpha");
  });

  test("the apex is the platform, not a tenant", () => {
    expect(subdomainFromHost("example.com", "example.com")).toBeNull();
  });

  test("a host on a different domain is not a tenant", () => {
    expect(subdomainFromHost("alpha.other.com", "example.com")).toBeNull();
  });

  test("multi-label hosts are a misconfiguration, not a nested tenant", () => {
    expect(subdomainFromHost("a.b.example.com", "example.com")).toBeNull();
  });

  test("reserved labels are refused even when they resolve", () => {
    expect(subdomainFromHost("admin.example.com", "example.com")).toBeNull();
    expect(subdomainFromHost("www.example.com", "example.com")).toBeNull();
  });

  test("strips the port", () => {
    expect(subdomainFromHost("alpha.example.com:4200", "example.com")).toBe("alpha");
  });

  /** The dev server binds [::1]:4200, so bracketed literals reach this code for real. */
  test("handles bracketed IPv6 literals without mistaking them for hosts", () => {
    expect(subdomainFromHost("[::1]:4200", "example.com")).toBeNull();
    expect(subdomainFromHost("[::1]", "example.com")).toBeNull();
  });

  test("normalises case", () => {
    expect(subdomainFromHost("ALPHA.EXAMPLE.COM", "example.com")).toBe("alpha");
  });

  test("null host, null result", () => {
    expect(subdomainFromHost(null, "example.com")).toBeNull();
    expect(subdomainFromHost(undefined, "example.com")).toBeNull();
  });
});

describe("subdomainFromPath", () => {
  test("reads the label out of /t/{sub}/...", () => {
    expect(subdomainFromPath("/t/alpha/dashboard")).toBe("alpha");
  });

  /** The tenant root is a valid address in its own right — it is the storefront home. */
  test("the bare tenant root resolves, with or without a trailing slash", () => {
    expect(subdomainFromPath("/t/alpha")).toBe("alpha");
    expect(subdomainFromPath("/t/alpha/")).toBe("alpha");
    expect(stripTenantPathPrefix("/t/alpha")).toBe("/");
    expect(stripTenantPathPrefix("/t/alpha/")).toBe("/");
  });

  /** `/t` alone addresses nothing — there is no label to look up. */
  test("the prefix alone is not an address", () => {
    expect(subdomainFromPath("/t")).toBeNull();
    expect(subdomainFromPath("/t/")).toBeNull();
  });

  test("ignores paths without the prefix", () => {
    expect(subdomainFromPath("/dashboard")).toBeNull();
    expect(subdomainFromPath("/")).toBeNull();
    expect(subdomainFromPath("")).toBeNull();
    expect(subdomainFromPath(null)).toBeNull();
  });

  test("refuses reserved labels — /t/admin/ is not the mothership", () => {
    expect(subdomainFromPath("/t/admin/tenants")).toBeNull();
  });

  test("normalises case", () => {
    expect(subdomainFromPath("/t/ALPHA/orders")).toBe("alpha");
  });
});

describe("stripTenantPathPrefix", () => {
  test("removes the prefix so downstream routing sees the canonical path", () => {
    expect(stripTenantPathPrefix("/t/alpha/dashboard")).toBe("/dashboard");
    expect(stripTenantPathPrefix("/t/alpha/orders/123")).toBe("/orders/123");
  });

  test("leaves untenanted paths alone", () => {
    expect(stripTenantPathPrefix("/dashboard")).toBe("/dashboard");
    expect(stripTenantPathPrefix("/t/admin/tenants")).toBe("/t/admin/tenants");
  });
});

describe("pickTenantCandidate — strategy order", () => {
  test("no signal at all yields no candidate", () => {
    expect(pickTenantCandidate({ host: "localhost:4200", path: "/dashboard" })).toBeNull();
  });

  test("host beats path", () => {
    process.env[ROOT] = "example.com";
    expect(pickTenantCandidate({ host: "alpha.example.com", path: "/t/bravo/dashboard" })).toEqual({
      key: "alpha",
      source: "subdomain",
      by: "subdomain",
    });
  });

  test("path is used when the host says nothing", () => {
    process.env[ROOT] = "example.com";
    expect(pickTenantCandidate({ host: "example.com", path: "/t/bravo/dashboard" })).toEqual({
      key: "bravo",
      source: "path-prefix",
      by: "subdomain",
    });
  });

  test("a host outside the root domain is treated as a custom domain, and outranks the path", () => {
    process.env[ROOT] = "example.com";
    expect(pickTenantCandidate({ host: "shop.alpha.com.au", path: "/t/bravo/dashboard" })).toEqual({
      key: "shop.alpha.com.au",
      source: "custom-domain",
      by: "customDomain",
    });
  });

  test("the platform's own host is never a custom domain", () => {
    process.env[ROOT] = "example.com";
    expect(pickTenantCandidate({ host: "example.com", path: "/dashboard" })).toBeNull();
    expect(pickTenantCandidate({ host: "admin.example.com", path: "/dashboard" })).toBeNull();
  });

  test("bracketed IPv6 hosts are never custom domains", () => {
    expect(pickTenantCandidate({ host: "[::1]:4200", path: "/dashboard" })).toBeNull();
  });

  describe("dev header", () => {
    const headers = new Headers({ [TENANT_DEV_HEADER]: "alpha" });

    test("is ignored unless TENANT_DEV_HEADER is exactly \"1\"", () => {
      expect(pickTenantCandidate({ host: "localhost", headers })).toBeNull();

      for (const value of ["0", "true", "yes", ""]) {
        process.env[DEV] = value;
        expect(pickTenantCandidate({ host: "localhost", headers })).toBeNull();
      }
    });

    test("is honoured when switched on", () => {
      process.env[DEV] = "1";
      expect(pickTenantCandidate({ host: "localhost", headers })).toEqual({
        key: "alpha",
        source: "dev-header",
        by: "subdomain",
      });
    });

    test("ranks below the path prefix", () => {
      process.env[DEV] = "1";
      expect(pickTenantCandidate({ host: "localhost", path: "/t/bravo/x", headers })?.source).toBe("path-prefix");
    });

    test("still refuses reserved labels", () => {
      process.env[DEV] = "1";
      const reserved = new Headers({ [TENANT_DEV_HEADER]: "admin" });
      expect(pickTenantCandidate({ host: "localhost", headers: reserved })).toBeNull();
    });
  });

  test("reads the host off the headers when none is passed explicitly", () => {
    process.env[ROOT] = "example.com";
    const headers = new Headers({ host: "alpha.example.com" });
    expect(pickTenantCandidate({ headers })?.key).toBe("alpha");
  });
});

describe("resolveTenant — against the database", () => {
  beforeEach(async () => {
    await resetModuleDb();
    await moduleDb.insert(tenants).values([
      { id: "t_alpha", subdomain: "alpha", name: "Alpha Supply Co", plan: "professional" },
      { id: "t_bravo", subdomain: "bravo", name: "Bravo Wholesale", plan: "starter", isActive: false },
      {
        id: "t_charlie",
        subdomain: "charlie",
        name: "Charlie Trading",
        plan: "starter",
        customDomain: "shop.charlie.com.au",
        domainStatus: "active",
      },
      {
        id: "t_delta",
        subdomain: "delta",
        name: "Delta Group",
        plan: "starter",
        customDomain: "shop.delta.com.au",
        domainStatus: "pending",
      },
    ]);
  });

  test("no addressing yields NO_TENANT", async () => {
    const result = await resolveTenant({ host: "localhost:4200", path: "/dashboard" });
    expect(result).toEqual({ tenant: null, source: "none", key: null, unknown: false });
  });

  test("resolves via the path prefix", async () => {
    const result = await resolveTenant({ host: "localhost:4200", path: "/t/alpha/dashboard" });
    expect(result.source).toBe("path-prefix");
    expect(result.unknown).toBe(false);
    expect(result.tenant).toMatchObject({ id: "t_alpha", subdomain: "alpha", name: "Alpha Supply Co" });
  });

  test("resolves via the subdomain once the root domain is set — the deploy-time switch", async () => {
    process.env[ROOT] = "example.com";
    const result = await resolveTenant({ host: "alpha.example.com", path: "/dashboard" });
    expect(result.source).toBe("subdomain");
    expect(result.tenant?.id).toBe("t_alpha");
  });

  test("resolves an active custom domain", async () => {
    const result = await resolveTenant({ host: "shop.charlie.com.au", path: "/" });
    expect(result.source).toBe("custom-domain");
    expect(result.tenant?.id).toBe("t_charlie");
  });

  /** A domain the tenant has claimed but not verified must not start serving their storefront. */
  test("ignores a custom domain that is not active", async () => {
    const result = await resolveTenant({ host: "shop.delta.com.au", path: "/" });
    expect(result.tenant).toBeNull();
    expect(result.unknown).toBe(true);
    expect(result.key).toBe("shop.delta.com.au");
  });

  test("an addressed-but-missing tenant is `unknown`, not `none` — render a 404, not an empty app", async () => {
    const result = await resolveTenant({ host: "localhost", path: "/t/nosuchtenant/dashboard" });
    expect(result).toEqual({ tenant: null, source: "path-prefix", key: "nosuchtenant", unknown: true });
  });

  /** Suspension is enforced in the middleware, not here — the mothership must still be able to look. */
  test("a suspended tenant still resolves", async () => {
    const result = await resolveTenant({ host: "localhost", path: "/t/bravo/dashboard" });
    expect(result.tenant?.id).toBe("t_bravo");
    expect(result.tenant?.isActive).toBe(false);
  });

  test("resolves via the dev header when it is switched on", async () => {
    process.env[DEV] = "1";
    const result = await resolveTenant({
      host: "localhost",
      headers: new Headers({ [TENANT_DEV_HEADER]: "alpha" }),
    });
    expect(result.source).toBe("dev-header");
    expect(result.tenant?.id).toBe("t_alpha");
  });

  test("the dev header cannot spoof a tenant while it is off", async () => {
    const result = await resolveTenant({
      host: "localhost",
      headers: new Headers({ [TENANT_DEV_HEADER]: "alpha" }),
    });
    expect(result.tenant).toBeNull();
    expect(result.source).toBe("none");
  });

  test("resolveTenantById loads the caller's own tenant", async () => {
    expect(await resolveTenantById("t_alpha")).toMatchObject({ id: "t_alpha", subdomain: "alpha" });
  });

  test("resolveTenantById returns null for an id that no longer exists", async () => {
    expect(await resolveTenantById("t_gone")).toBeNull();
  });
});
