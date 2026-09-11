import { beforeEach, describe, expect, test } from "bun:test";
import { asc, desc, eq } from "drizzle-orm";
import { products, shippingRates } from "../src/api/database/schema";
import { runWithRequestContext } from "../src/api/tenant/context";
import { scopedDb, TenantScopeError, type ScopedDb } from "../src/api/tenant/guard";
import { createTestDb, type TestDb } from "./helpers/db";
import { ctxA, ctxSuper, seed, TENANT_A, TENANT_B, type Seed } from "./helpers/seed";

/**
 * Port of the old repo's `tests/rls-prisma.test.ts` (21 tests) — the suite that mattered most.
 *
 * Its whole point was: a service that FORGETS its tenant filter must still be isolated. Under
 * Postgres the database refused. Here the guard has to, so every test below issues a query with
 * no explicit tenant predicate and asserts the result is still one tenant's data.
 */

let db: TestDb;
let fixtures: Seed;

beforeEach(async () => {
  db = await createTestDb();
  fixtures = await seed(db);
});

const asA = (): ScopedDb => scopedDb(ctxA, db);

describe("a service that forgot the filter", () => {
  test("products.findMany() with no where returns only tenant A", async () => {
    const rows = await asA().products.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });

  test("orders.findMany() with no where returns only tenant A", async () => {
    const rows = await asA().orders.findMany();
    expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  test("companies.findMany() with no where returns only tenant A", async () => {
    expect(await asA().companies.count()).toBe(1);
  });

  test("carts.findMany() with no where returns only tenant A", async () => {
    const rows = await asA().carts.findMany();
    expect(rows.map((r) => r.id)).toEqual([fixtures.cartA]);
  });

  test("payments.findMany() with no where returns only tenant A", async () => {
    const rows = await asA().payments.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });

  test("findFirst() with no where cannot surface another tenant's row", async () => {
    const row = await asA().products.findFirst();
    expect(row?.tenantId).toBe(TENANT_A);
  });

  test("count() with no where counts only the caller's tenant", async () => {
    const total = await db.select().from(products);
    expect(total).toHaveLength(2);
    expect(await asA().products.count()).toBe(1);
  });

  /**
   * Uses a leaf table (`shippingRates`) rather than `products`, which is referenced by price
   * tiers, inventory events, cart items and order line items. A bare `products.delete()` trips
   * a foreign-key violation before the scope predicate can be judged — and did under Postgres
   * too, where the old Prisma schema's missing referential actions meant `Restrict`. The claim
   * under test is that an unfiltered delete still only reaches one tenant's rows.
   */
  test("delete() with no where deletes only the caller's rows", async () => {
    await asA().shippingRates.delete();
    const remaining = await db.select().from(shippingRates);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tenantId).toBe(TENANT_B);
  });

  test("update() with no where updates only the caller's rows", async () => {
    await asA().products.update(undefined, { name: "Bulk renamed" });
    const rows = await db.select().from(products);
    const byTenant = Object.fromEntries(rows.map((r) => [r.tenantId, r.name]));
    expect(byTenant[TENANT_A]).toBe("Bulk renamed");
    expect(byTenant[TENANT_B]).toBe("Epoxy 500ml");
  });

  test("orderLineItems.findMany() with no where is scoped through the parent order", async () => {
    const rows = await asA().orderLineItems.findMany();
    expect(rows.map((r) => r.id)).toEqual([fixtures.lineItemA]);
  });

  test("orderLineItems.delete() with no where leaves the other tenant's items", async () => {
    await asA().orderLineItems.delete();
    expect(await asA().orderLineItems.count()).toBe(0);
    expect(await scopedDb({ ...ctxA, tenantId: TENANT_B }, db).orderLineItems.count()).toBe(1);
  });
});

describe("the scope predicate cannot be displaced", () => {
  test("a caller-supplied where is ANDed, never substituted", async () => {
    const rows = await asA().products.findMany({ where: eq(products.tenantId, TENANT_B) });
    expect(rows).toHaveLength(0);
  });

  test("a caller-supplied where narrows within the tenant", async () => {
    const rows = await asA().products.findMany({ where: eq(products.sku, "A-001") });
    expect(rows).toHaveLength(1);
  });

  test("limit and offset stay inside the scope", async () => {
    await asA().products.insert({ sku: "A-002", name: "Second", unitPriceCents: 900 });
    const page = await asA().products.findMany({ orderBy: asc(products.sku), limit: 5, offset: 0 });
    expect(page).toHaveLength(2);
    expect(page.every((r) => r.tenantId === TENANT_A)).toBe(true);
  });

  test("orderBy cannot pull in another tenant's rows", async () => {
    const rows = await asA().products.findMany({ orderBy: desc(products.unitPriceCents) });
    expect(rows.map((r) => r.tenantId)).toEqual([TENANT_A]);
  });

  test("update() silently drops a tenantId in the patch rather than applying it", async () => {
    await asA().products.update(undefined, { tenantId: TENANT_B });
    const rows = await db.select().from(products).where(eq(products.id, fixtures.productA));
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });
});

describe("inserts", () => {
  test("insertMany stamps every row", async () => {
    const rows = await asA().products.insertMany([
      { sku: "A-010", name: "Ten", unitPriceCents: 100 },
      { sku: "A-011", name: "Eleven", unitPriceCents: 200 },
    ]);
    expect(rows.map((r) => r.tenantId)).toEqual([TENANT_A, TENANT_A]);
  });

  test("insertMany with one foreign tenantId writes nothing", async () => {
    await expect(
      asA().products.insertMany([
        { sku: "A-020", name: "Fine", unitPriceCents: 100 },
        { sku: "A-021", name: "Smuggled", unitPriceCents: 200, tenantId: TENANT_B },
      ]),
    ).rejects.toThrow(TenantScopeError);
    expect(await asA().products.count()).toBe(1);
  });

  test("a super admin must name the tenant explicitly", async () => {
    await expect(
      scopedDb(ctxSuper, db).products.insert({ sku: "S-1", name: "No tenant", unitPriceCents: 1 }),
    ).rejects.toThrow(TenantScopeError);
    const row = await scopedDb(ctxSuper, db).products.insert({
      tenantId: TENANT_B,
      sku: "S-2",
      name: "Explicit",
      unitPriceCents: 1,
    });
    expect(row.tenantId).toBe(TENANT_B);
  });
});

describe("the lazy-promise hazard that bit the Prisma build", () => {
  test("a query started inside the context and awaited outside is still tenant-scoped", async () => {
    // The old bug: `runWithRequestContext(ctx, () => db.x.findMany())` handed back an unexecuted
    // PrismaPromise, so the query ran after the AsyncLocalStorage scope had already exited and
    // saw no session variables. Here scopedDb() snapshots the context synchronously, so even a
    // deferred await stays bound to the right tenant.
    let pending: Promise<{ tenantId: string }[]> | undefined;
    await runWithRequestContext(ctxA, async () => {
      pending = scopedDb(undefined, db).products.findMany();
    });
    expect(pending).toBeDefined();
    const rows = await pending!;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });

  test("scopedDb() inside runWithRequestContext resolves the ambient tenant", async () => {
    const rows = await runWithRequestContext(ctxA, async () => await scopedDb(undefined, db).products.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });
});
