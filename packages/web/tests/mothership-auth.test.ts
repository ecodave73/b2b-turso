import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { tenants, users } from "../src/api/database/schema";
import { getRequestContext, MissingRequestContextError, requireRequestContext, runWithRequestContext } from "../src/api/tenant/context";
import { scopedDb, TenantScopeError, unscopedDb } from "../src/api/tenant/guard";
import { createTestDb, type TestDb } from "./helpers/db";
import { ctxA, ctxAnon, ctxB, ctxSuper, ctxUnresolved, seed, TENANT_A, TENANT_B, type Seed } from "./helpers/seed";

/**
 * Port of the old repo's `tests/mothership-auth.test.ts` (22 tests). Role gating was already
 * enforced in the application layer there, so these carry across almost unchanged — what moved
 * is the tenant/user visibility rules, which used to be `user_policy` and `tenant_select_policy`.
 */

let db: TestDb;
let fixtures: Seed;

beforeEach(async () => {
  db = await createTestDb();
  fixtures = await seed(db);
});

describe("SUPER_ADMIN sees the whole platform", () => {
  test("all products across tenants", async () => {
    expect(await scopedDb(ctxSuper, db).products.count()).toBe(2);
  });

  test("all orders across tenants", async () => {
    const rows = await scopedDb(ctxSuper, db).orders.findMany();
    expect(rows.map((r) => r.id).sort()).toEqual([fixtures.orderA, fixtures.orderB].sort());
  });

  test("all companies across tenants", async () => {
    expect(await scopedDb(ctxSuper, db).companies.count()).toBe(2);
  });

  test("all tenants", async () => {
    expect(await scopedDb(ctxSuper, db).tenants.findMany()).toHaveLength(2);
  });

  test("all users", async () => {
    expect(await scopedDb(ctxSuper, db).users.findMany()).toHaveLength(5);
  });

  test("all order line items, across both tenants' orders", async () => {
    expect(await scopedDb(ctxSuper, db).orderLineItems.count()).toBe(2);
  });

  /**
   * Deletes an *empty* tenant on purpose. The old Prisma schema declared no referential
   * actions, so Postgres got Prisma's defaults — `Restrict` for required relations — and
   * deleting a populated tenant raised a foreign-key violation there exactly as it does here.
   * Tearing down a tenant with data is a cascade the mothership console has to perform
   * explicitly (phase 5); this test covers the super-admin-only gate, not that cascade.
   */
  test("can delete an empty tenant", async () => {
    const created = await scopedDb(ctxSuper, db).tenants.insert({
      id: "tenant_empty",
      subdomain: "empty",
      name: "Nothing Here Pty Ltd",
    });
    const deleted = await scopedDb(ctxSuper, db).tenants.deleteById(created.id);
    expect(deleted?.id).toBe("tenant_empty");
    expect(await scopedDb(ctxSuper, db).tenants.findById("tenant_empty")).toBeUndefined();
  });

  test("deleting a tenant that still has data is refused by referential integrity", async () => {
    await expect(scopedDb(ctxSuper, db).tenants.deleteById(TENANT_B)).rejects.toThrow();
  });

  test("can suspend any tenant", async () => {
    await scopedDb(ctxSuper, db).tenants.updateById(TENANT_B, { isActive: false });
    const row = await db.select().from(tenants).where(eq(tenants.id, TENANT_B));
    expect(row[0]?.isActive).toBe(false);
  });
});

describe("user visibility — the old user_policy", () => {
  test("a tenant admin sees their own tenant's users plus unassigned ones", async () => {
    const rows = await scopedDb(ctxA, db).users.findMany();
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["user_a_admin", "user_a_staff", "user_unassigned"]);
  });

  /**
   * DELIBERATE DEVIATION from the old `user_policy`, approved by the user in the phase-1 review.
   * The original clause `("tenantId" IS NULL AND current_tenant_id() IS NOT NULL)` exposed every
   * tenant-null user to any tenant admin — and the platform SUPER_ADMIN is tenant-null by
   * definition, so a tenant admin could read it and claim it into their own tenant. The guard is
   * intentionally stricter here than the RLS it replaces. These three tests pin that.
   */
  test("a tenant admin cannot see the platform super admin, despite it being unassigned", async () => {
    const rows = await scopedDb(ctxA, db).users.findMany();
    expect(rows.some((r) => r.id === "user_super")).toBe(false);
    expect(await scopedDb(ctxA, db).users.findById("user_super")).toBeUndefined();
  });

  test("a tenant admin cannot claim the platform super admin into their tenant", async () => {
    const rows = await scopedDb(ctxA, db).users.update(eq(users.id, "user_super"), { tenantId: TENANT_A });
    expect(rows).toHaveLength(0);
    const row = await db.select().from(users).where(eq(users.id, "user_super"));
    expect(row[0]?.tenantId).toBeNull();
    expect(row[0]?.role).toBe("SUPER_ADMIN");
  });

  test("a tenant admin cannot mint a new platform super admin", async () => {
    await expect(
      scopedDb(ctxA, db).users.insert({ id: "u_escalate", email: "evil@alpha.test", role: "SUPER_ADMIN" }),
    ).rejects.toThrow(TenantScopeError);
  });

  test("a tenant admin cannot see another tenant's users", async () => {
    const rows = await scopedDb(ctxA, db).users.findMany();
    expect(rows.some((r) => r.id === "user_b_admin")).toBe(false);
  });

  test("unassigned users are visible so a tenant admin can claim one", async () => {
    const row = await scopedDb(ctxB, db).users.findById("user_unassigned");
    expect(row?.tenantId).toBeNull();
  });

  test("a user can always see themselves, even before a tenant is resolved", async () => {
    const row = await scopedDb(ctxUnresolved, db).users.findById("user_unassigned");
    expect(row?.id).toBe("user_unassigned");
  });

  test("an anonymous request sees no users at all", async () => {
    expect(await scopedDb(ctxAnon, db).users.findMany()).toHaveLength(0);
  });

  test("a tenant admin cannot move a user into another tenant", async () => {
    await expect(scopedDb(ctxA, db).users.insert({ id: "u_x", tenantId: TENANT_B })).rejects.toThrow(TenantScopeError);
  });

  test("a tenant admin can claim an unassigned user into their own tenant", async () => {
    const rows = await scopedDb(ctxA, db).users.update(eq(users.id, "user_unassigned"), { tenantId: TENANT_A });
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });

  test("a tenant admin cannot claim another tenant's user", async () => {
    const rows = await scopedDb(ctxA, db).users.update(eq(users.id, "user_b_admin"), { tenantId: TENANT_A });
    expect(rows).toHaveLength(0);
    const row = await db.select().from(users).where(eq(users.id, "user_b_admin"));
    expect(row[0]?.tenantId).toBe(TENANT_B);
  });
});

describe("tenant visibility — the old tenant_select_policy", () => {
  test("with no tenant context every tenant is readable, so host routing works", async () => {
    expect(await scopedDb(ctxUnresolved, db).tenants.findMany()).toHaveLength(2);
  });

  test("once a tenant context is set the caller is pinned to their own row", async () => {
    const rows = await scopedDb(ctxA, db).tenants.findMany();
    expect(rows.map((r) => r.id)).toEqual([TENANT_A]);
  });

  test("a tenant cannot read another tenant by id", async () => {
    expect(await scopedDb(ctxA, db).tenants.findById(TENANT_B)).toBeUndefined();
  });

  test("a tenant can update its own row", async () => {
    await scopedDb(ctxA, db).tenants.updateById(TENANT_A, { brandColor: "#012345" });
    const row = await db.select().from(tenants).where(eq(tenants.id, TENANT_A));
    expect(row[0]?.brandColor).toBe("#012345");
  });

  test("updating another tenant's row is a no-op", async () => {
    const updated = await scopedDb(ctxA, db).tenants.updateById(TENANT_B, { brandColor: "#ffffff" });
    expect(updated).toBeUndefined();
    const row = await db.select().from(tenants).where(eq(tenants.id, TENANT_B));
    expect(row[0]?.brandColor).toBe("#1a1a2e");
  });

  test("an authenticated user with no tenant can create one (self-service signup)", async () => {
    const row = await scopedDb(ctxUnresolved, db).tenants.insert({ subdomain: "charlie", name: "Charlie Trading" });
    expect(row.subdomain).toBe("charlie");
  });

  test("an anonymous request cannot create a tenant", async () => {
    await expect(scopedDb(ctxAnon, db).tenants.insert({ subdomain: "nope", name: "Nope" })).rejects.toThrow(
      TenantScopeError,
    );
  });

  test("a tenant admin cannot delete their own tenant — that is a super-admin action", async () => {
    await expect(scopedDb(ctxA, db).tenants.deleteById(TENANT_A)).rejects.toThrow(TenantScopeError);
    expect(await db.select().from(tenants)).toHaveLength(2);
  });
});

describe("the cross-tenant escape hatch", () => {
  test("unscopedDb requires a reason", () => {
    expect(() => unscopedDb("")).toThrow(TenantScopeError);
  });

  test("unscopedDb rejects a throwaway reason", () => {
    expect(() => unscopedDb("why")).toThrow(TenantScopeError);
  });

  test("unscopedDb returns a client when the reason is real", () => {
    expect(unscopedDb("mothership platform stats span every tenant")).toBeDefined();
  });
});

describe("request context plumbing", () => {
  test("requireRequestContext throws outside a scope", () => {
    expect(() => requireRequestContext()).toThrow(MissingRequestContextError);
  });

  test("getRequestContext returns the ambient context inside a scope", async () => {
    const seen = await runWithRequestContext(ctxA, async () => getRequestContext());
    expect(seen?.tenantId).toBe(TENANT_A);
  });

  test("scopedDb() with no argument reads the ambient context", async () => {
    const tenantId = await runWithRequestContext(ctxB, async () => scopedDb(undefined, db).ctx.tenantId);
    expect(tenantId).toBe(TENANT_B);
  });
});
