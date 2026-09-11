/**
 * The middleware chain, driven end to end: base -> withUser -> withTenant -> authed -> role bases.
 *
 * These were the phase-2 debt. Every branch below was exercised live over HTTP when the server
 * half was built, so this is transcription of known-good behaviour rather than discovery — but
 * live curl output does not fail a build, and phase 3 is about to add the first real callers.
 *
 * Deliberately NOT mocked. Sessions come from `auth.api.signUpEmail()` and procedures are invoked
 * with oRPC's `call()`, so the thing under test is the actual chain a request goes through:
 * Better Auth reads the real cookie, `resolveTenant` reads the real database, and the guard
 * builds a real scoped client. Mocking `auth` here would leave the one integration that matters
 * — session user -> RequestContext -> tenant — untested.
 *
 * The module-level database is shared process-wide (Better Auth is constructed once against it),
 * so every test resets it rather than building a fresh instance.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { call, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { auth } from "../src/api/auth";
import { tenants, users } from "../src/api/database/schema";
import type { Role } from "../src/api/tenant/context";
import {
  authed,
  requireTenantId,
  superAdmin,
  tenantAdmin,
  tenantStaff,
  withTenant,
} from "../src/api/middleware/auth";
import { session } from "../src/api/routes/session";
import { TENANT_DEV_HEADER, TENANT_PATH_HEADER } from "../src/api/tenant/resolve";
import { migrateModuleDb, moduleDb, resetModuleDb } from "./helpers/module-db";

const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_bravo";
const PASSWORD = "correct-horse-battery-staple";

// ---------------------------------------------------------------------------
// Probe procedures — one per base, so a failure names the base that broke.
// ---------------------------------------------------------------------------

/** Reports the RequestContext the chain built. The single most useful thing to assert. */
const whoami = authed.handler(({ context }) => ({
  userId: context.ctx.userId,
  tenantId: context.ctx.tenantId,
  role: context.ctx.role,
  tenantName: context.tenant?.name ?? null,
  source: context.tenantResolution.source,
}));

const adminOnly = tenantAdmin.handler(() => "admin-ok");
const staffOnly = tenantStaff.handler(() => "staff-ok");
const platformOnly = superAdmin.handler(() => "platform-ok");
const needsTenant = withTenant.handler(({ context }) => requireTenantId(context.ctx));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Collapse Set-Cookie into a Cookie header the way a browser would. */
function cookieHeader(headers: Headers): string {
  const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  return all
    .filter(Boolean)
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

interface Caller {
  id: string;
  cookie: string;
}

/**
 * A real signed-up user. `role` and `tenantId` are `input: false` on the Better Auth model —
 * the client can never write them — so they are set directly afterwards, which is what the
 * signup procedure and the mothership do.
 */
async function signUp(email: string, patch: { tenantId?: string | null; role?: Role } = {}): Promise<Caller> {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: email.split("@")[0] },
    returnHeaders: true,
  });
  const id = response.user.id;
  if (patch.tenantId !== undefined || patch.role !== undefined) {
    await moduleDb
      .update(users)
      .set({ tenantId: patch.tenantId ?? null, role: patch.role ?? "TENANT_CLIENT" })
      .where(eq(users.id, id));
  }
  return { id, cookie: cookieHeader(headers) };
}

/** Build the request headers: an optional session, an optional addressed tenant. */
function requestHeaders(caller: Caller | null, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ host: "localhost:4200", ...extra });
  if (caller) headers.set("cookie", caller.cookie);
  return headers;
}

/** Address a tenant the way the web client does — the path the browser is on. */
function addressing(subdomain: string): Record<string, string> {
  return { [TENANT_PATH_HEADER]: `/t/${subdomain}/dashboard` };
}

/** `any` is deliberate: the probes above are five different procedure shapes on five bases. */
async function invoke<T>(procedure: any, headers: Headers): Promise<T> {
  return (await call(procedure, undefined, { context: { headers } })) as T;
}

async function expectRejection(promise: Promise<unknown>, code: string, matcher?: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ORPCError);
  const error = thrown as ORPCError<string, unknown>;
  expect(error.code).toBe(code);
  if (matcher) expect(error.message).toMatch(matcher);
}

async function setSuspended(tenantId: string, suspended: boolean): Promise<void> {
  await moduleDb.update(tenants).set({ isActive: !suspended }).where(eq(tenants.id, tenantId));
}

beforeAll(async () => {
  await migrateModuleDb();
});

beforeEach(async () => {
  await resetModuleDb();
  await moduleDb.insert(tenants).values([
    { id: TENANT_A, subdomain: "alpha", name: "Alpha Supply Co", plan: "professional" },
    { id: TENANT_B, subdomain: "bravo", name: "Bravo Wholesale", plan: "starter" },
  ]);
});

// ---------------------------------------------------------------------------

describe("withUser — optional auth", () => {
  test("an anonymous request has no user and is not rejected", async () => {
    const result = await invoke<{ user: unknown }>(session.current, requestHeaders(null));
    expect(result.user).toBeNull();
  });

  test("a signed-in request carries the session user, role included", async () => {
    const caller = await signUp("staff@alpha.test", { tenantId: TENANT_A, role: "TENANT_STAFF" });
    const result = await invoke<{ user: { id: string; role: string; tenantId: string } | null }>(
      session.current,
      requestHeaders(caller),
    );
    expect(result.user?.id).toBe(caller.id);
    expect(result.user?.role).toBe("TENANT_STAFF");
    expect(result.user?.tenantId).toBe(TENANT_A);
  });

  test("a garbage session cookie is treated as anonymous, not as an error", async () => {
    const headers = requestHeaders(null, { cookie: "better-auth.session_token=not-a-real-token" });
    const result = await invoke<{ user: unknown }>(session.current, headers);
    expect(result.user).toBeNull();
  });
});

describe("withTenant — which tenant wins", () => {
  test("anonymous storefront visitor gets the addressed tenant", async () => {
    const result = await invoke<{
      user: unknown;
      tenant: { id: string; name: string } | null;
      resolution: { source: string };
    }>(session.current, requestHeaders(null, addressing("alpha")));

    expect(result.user).toBeNull();
    expect(result.tenant?.id).toBe(TENANT_A);
    expect(result.tenant?.name).toBe("Alpha Supply Co");
    expect(result.resolution.source).toBe("path-prefix");
  });

  test("a member on an unaddressed path still gets the tenant from their own user row", async () => {
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    const result = await invoke<{ tenantId: string; source: string; tenantName: string }>(
      whoami,
      requestHeaders(caller),
    );
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.tenantName).toBe("Alpha Supply Co");
    // Nothing addressed a tenant; it came off the user row.
    expect(result.source).toBe("none");
  });

  test("a member addressing their OWN tenant is fine", async () => {
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    const result = await invoke<{ tenantId: string; source: string }>(
      whoami,
      requestHeaders(caller, addressing("alpha")),
    );
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.source).toBe("path-prefix");
  });

  /** The one that matters: refused loudly, never downgraded to an empty account. */
  test("a member addressing ANOTHER tenant is refused with FORBIDDEN", async () => {
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    await expectRejection(
      invoke(whoami, requestHeaders(caller, addressing("bravo"))),
      "FORBIDDEN",
      /does not belong to the tenant/i,
    );
  });

  test("the cross-tenant refusal applies to the read-only session probe too", async () => {
    const caller = await signUp("client@alpha.test", { tenantId: TENANT_A, role: "TENANT_CLIENT" });
    await expectRejection(invoke(session.current, requestHeaders(caller, addressing("bravo"))), "FORBIDDEN");
  });

  test("a tenant-less user addressing a tenant does NOT get adopted by it", async () => {
    const caller = await signUp("nobody@nowhere.test", { tenantId: null, role: "TENANT_CLIENT" });
    const result = await invoke<{ tenantId: string | null }>(whoami, requestHeaders(caller, addressing("alpha")));
    // No FORBIDDEN — they addressed a tenant they simply are not in — but no tenant either.
    expect(result.tenantId).toBeNull();
  });

  test("an unknown subdomain resolves to no tenant and flags itself unknown", async () => {
    const result = await invoke<{ tenant: unknown; resolution: { unknown: boolean; key: string | null } }>(
      session.current,
      requestHeaders(null, addressing("does-not-exist")),
    );
    expect(result.tenant).toBeNull();
    expect(result.resolution.unknown).toBe(true);
    expect(result.resolution.key).toBe("does-not-exist");
  });

  test("the dev header is ignored unless TENANT_DEV_HEADER is exactly '1'", async () => {
    const previous = process.env.TENANT_DEV_HEADER;
    try {
      delete process.env.TENANT_DEV_HEADER;
      const off = await invoke<{ tenant: unknown; resolution: { source: string } }>(
        session.current,
        requestHeaders(null, { [TENANT_DEV_HEADER]: "alpha" }),
      );
      expect(off.tenant).toBeNull();
      expect(off.resolution.source).toBe("none");

      process.env.TENANT_DEV_HEADER = "1";
      const on = await invoke<{ tenant: { id: string } | null; resolution: { source: string } }>(
        session.current,
        requestHeaders(null, { [TENANT_DEV_HEADER]: "alpha" }),
      );
      expect(on.tenant?.id).toBe(TENANT_A);
      expect(on.resolution.source).toBe("dev-header");
    } finally {
      if (previous === undefined) delete process.env.TENANT_DEV_HEADER;
      else process.env.TENANT_DEV_HEADER = previous;
    }
  });
});

describe("withTenant — suspension", () => {
  /**
   * DELIBERATE DEVIATION from the old stack, confirmed at the phase-2 review as a bug fix:
   * `isActive` never sat on the old request path, so suspending a tenant changed nothing but a
   * mothership statistic. It now actually cuts access.
   *
   * Reminder for phase 6: this is an OPS switch, not a billing switch. Dunning gets its own
   * subscriptionStatus field — routing a failed card through here would be a hard lockout that
   * support cannot distinguish from a real suspension.
   */
  test("a member of a suspended tenant is refused", async () => {
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    await setSuspended(TENANT_A, true);
    await expectRejection(invoke(whoami, requestHeaders(caller)), "FORBIDDEN", /suspended/i);
  });

  test("suspension holds even when the member addresses the tenant explicitly", async () => {
    const caller = await signUp("staff@alpha.test", { tenantId: TENANT_A, role: "TENANT_STAFF" });
    await setSuspended(TENANT_A, true);
    await expectRejection(invoke(whoami, requestHeaders(caller, addressing("alpha"))), "FORBIDDEN", /suspended/i);
  });

  test("a suspended tenant's storefront is closed to anonymous visitors too", async () => {
    await setSuspended(TENANT_A, true);
    await expectRejection(invoke(session.current, requestHeaders(null, addressing("alpha"))), "FORBIDDEN", /suspended/i);
  });

  test("a SUPER_ADMIN is exempt, so support can inspect and reactivate", async () => {
    const root = await signUp("root@platform.test", { tenantId: null, role: "SUPER_ADMIN" });
    await setSuspended(TENANT_A, true);
    const result = await invoke<{ tenantId: string; role: string }>(
      whoami,
      requestHeaders(root, addressing("alpha")),
    );
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.role).toBe("SUPER_ADMIN");
  });

  test("reactivating restores access", async () => {
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    await setSuspended(TENANT_A, true);
    await expectRejection(invoke(whoami, requestHeaders(caller)), "FORBIDDEN");
    await setSuspended(TENANT_A, false);
    const result = await invoke<{ tenantId: string }>(whoami, requestHeaders(caller));
    expect(result.tenantId).toBe(TENANT_A);
  });

  test("a suspended OTHER tenant does not affect an unrelated tenant's members", async () => {
    const caller = await signUp("admin@bravo.test", { tenantId: TENANT_B, role: "TENANT_ADMIN" });
    await setSuspended(TENANT_A, true);
    const result = await invoke<{ tenantId: string }>(whoami, requestHeaders(caller));
    expect(result.tenantId).toBe(TENANT_B);
  });
});

describe("withTenant — super admins", () => {
  test("a super admin adopts the tenant they address", async () => {
    const root = await signUp("root@platform.test", { tenantId: null, role: "SUPER_ADMIN" });
    const result = await invoke<{ tenantId: string; tenantName: string }>(
      whoami,
      requestHeaders(root, addressing("bravo")),
    );
    expect(result.tenantId).toBe(TENANT_B);
    expect(result.tenantName).toBe("Bravo Wholesale");
  });

  test("a super admin addressing nothing has no tenant — they must say which they mean", async () => {
    const root = await signUp("root@platform.test", { tenantId: null, role: "SUPER_ADMIN" });
    const result = await invoke<{ tenantId: string | null; role: string }>(whoami, requestHeaders(root));
    expect(result.tenantId).toBeNull();
    expect(result.role).toBe("SUPER_ADMIN");
  });

  test("a super admin is never refused for cross-tenant addressing", async () => {
    const root = await signUp("root@platform.test", { tenantId: null, role: "SUPER_ADMIN" });
    for (const subdomain of ["alpha", "bravo"]) {
      const result = await invoke<{ tenantId: string }>(whoami, requestHeaders(root, addressing(subdomain)));
      expect(result.tenantId).toBe(subdomain === "alpha" ? TENANT_A : TENANT_B);
    }
  });
});

describe("authed", () => {
  test("rejects anonymous with UNAUTHORIZED", async () => {
    await expectRejection(invoke(whoami, requestHeaders(null)), "UNAUTHORIZED");
  });

  test("admits a signed-in user", async () => {
    const caller = await signUp("client@alpha.test", { tenantId: TENANT_A, role: "TENANT_CLIENT" });
    const result = await invoke<{ userId: string }>(whoami, requestHeaders(caller));
    expect(result.userId).toBe(caller.id);
  });

  test("an unrecognised role on the row falls back to least privilege, not to a crash", async () => {
    const caller = await signUp("weird@alpha.test", { tenantId: TENANT_A });
    await moduleDb.update(users).set({ role: "WIZARD" }).where(eq(users.id, caller.id));
    const result = await invoke<{ role: string }>(whoami, requestHeaders(caller));
    expect(result.role).toBe("TENANT_CLIENT");
  });
});

describe("role gates", () => {
  test("tenantAdmin admits TENANT_ADMIN", async () => {
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    expect(await invoke(adminOnly, requestHeaders(caller))).toBe("admin-ok");
  });

  test("tenantAdmin refuses TENANT_STAFF and TENANT_CLIENT", async () => {
    const staff = await signUp("staff@alpha.test", { tenantId: TENANT_A, role: "TENANT_STAFF" });
    await expectRejection(invoke(adminOnly, requestHeaders(staff)), "FORBIDDEN", /TENANT_ADMIN/);
    const client = await signUp("client@alpha.test", { tenantId: TENANT_A, role: "TENANT_CLIENT" });
    await expectRejection(invoke(adminOnly, requestHeaders(client)), "FORBIDDEN", /TENANT_ADMIN/);
  });

  test("tenantStaff admits both back-office roles", async () => {
    const admin = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    expect(await invoke(staffOnly, requestHeaders(admin))).toBe("staff-ok");
    const staff = await signUp("staff@alpha.test", { tenantId: TENANT_A, role: "TENANT_STAFF" });
    expect(await invoke(staffOnly, requestHeaders(staff))).toBe("staff-ok");
  });

  test("tenantStaff refuses TENANT_CLIENT — the buyer never reaches the back office", async () => {
    const client = await signUp("client@alpha.test", { tenantId: TENANT_A, role: "TENANT_CLIENT" });
    await expectRejection(invoke(staffOnly, requestHeaders(client)), "FORBIDDEN");
  });

  test("a SUPER_ADMIN passes every tenant gate, mirroring the old requireRole", async () => {
    const root = await signUp("root@platform.test", { tenantId: null, role: "SUPER_ADMIN" });
    expect(await invoke(adminOnly, requestHeaders(root, addressing("alpha")))).toBe("admin-ok");
    expect(await invoke(staffOnly, requestHeaders(root, addressing("alpha")))).toBe("staff-ok");
  });

  test("the superAdmin base has no bypass to hand out — it IS the bypass", async () => {
    const admin = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    await expectRejection(invoke(platformOnly, requestHeaders(admin)), "FORBIDDEN", /Platform administrators/);
    const root = await signUp("root@platform.test", { tenantId: null, role: "SUPER_ADMIN" });
    expect(await invoke(platformOnly, requestHeaders(root))).toBe("platform-ok");
  });

  test("the superAdmin base rejects anonymous before it checks the role", async () => {
    await expectRejection(invoke(platformOnly, requestHeaders(null)), "UNAUTHORIZED");
  });
});

describe("requireTenantId", () => {
  test("returns the tenant id when there is one", async () => {
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    expect(await invoke(needsTenant, requestHeaders(caller))).toBe(TENANT_A);
  });

  test("BAD_REQUEST for a signed-in user with no tenant", async () => {
    const caller = await signUp("nobody@nowhere.test", { tenantId: null, role: "TENANT_CLIENT" });
    await expectRejection(invoke(needsTenant, requestHeaders(caller)), "BAD_REQUEST", /No tenant for this request/);
  });

  test("BAD_REQUEST for a super admin who has not said which tenant they mean", async () => {
    const root = await signUp("root@platform.test", { tenantId: null, role: "SUPER_ADMIN" });
    await expectRejection(invoke(needsTenant, requestHeaders(root)), "BAD_REQUEST");
  });

  test("BAD_REQUEST for an anonymous request that addressed nothing", async () => {
    await expectRejection(invoke(needsTenant, requestHeaders(null)), "BAD_REQUEST");
  });
});

describe("the scoped client the chain installs", () => {
  test("context.db is pinned to the caller's tenant", async () => {
    const probe = authed.handler(async ({ context }) => {
      const rows = await context.db.tenants.findMany();
      return rows.map((row) => row.id);
    });
    const caller = await signUp("admin@alpha.test", { tenantId: TENANT_A, role: "TENANT_ADMIN" });
    const visible = await invoke<string[]>(probe, requestHeaders(caller));
    expect(visible).toEqual([TENANT_A]);
  });

  test("an anonymous storefront request is scoped to the addressed tenant, not to everything", async () => {
    const probe = withTenant.handler(async ({ context }) => {
      const rows = await context.db.tenants.findMany();
      return rows.map((row) => row.id);
    });
    const visible = await invoke<string[]>(probe, requestHeaders(null, addressing("bravo")));
    expect(visible).toEqual([TENANT_B]);
  });
});
