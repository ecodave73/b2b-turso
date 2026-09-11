import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { featureFlags, products } from "../src/api/database/schema";
import { scopedDb, TenantScopeError } from "../src/api/tenant/guard";
import { createTestDb, type TestDb } from "./helpers/db";
import { ctxA, ctxAnon, ctxB, seed, TENANT_A, TENANT_B, type Seed } from "./helpers/seed";

/**
 * Port of the old repo's `tests/rls-isolation.test.ts` (27 tests), retargeted from PostgreSQL
 * row-level security at the guard layer. Same assertions, different enforcement point.
 */

let db: TestDb;
let fixtures: Seed;

beforeEach(async () => {
  db = await createTestDb();
  fixtures = await seed(db);
});

const asA = () => scopedDb(ctxA, db);
const asB = () => scopedDb(ctxB, db);

describe("tenant isolation — reads", () => {
  test("tenant A sees only its own products", async () => {
    const rows = await asA().products.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });

  test("tenant B sees only its own products", async () => {
    const rows = await asB().products.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_B);
  });

  test("findById across tenants returns undefined", async () => {
    expect(await asA().products.findById(fixtures.productB)).toBeUndefined();
    expect(await asA().products.findById(fixtures.productA)).toBeDefined();
  });

  test("count is tenant-scoped", async () => {
    expect(await asA().products.count()).toBe(1);
    expect(await asB().products.count()).toBe(1);
  });

  test("orders are tenant-scoped", async () => {
    const rows = await asA().orders.findMany();
    expect(rows.map((r) => r.id)).toEqual([fixtures.orderA]);
  });

  test("an order from another tenant is not readable by id", async () => {
    expect(await asA().orders.findById(fixtures.orderB)).toBeUndefined();
  });

  test("companies are tenant-scoped", async () => {
    const rows = await asA().companies.findMany();
    expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  test("categories are tenant-scoped", async () => {
    expect(await asB().categories.count()).toBe(1);
    expect((await asB().categories.findMany())[0]?.slug).toBe("adhesives");
  });

  test("price tiers are tenant-scoped", async () => {
    const rows = await asA().priceTiers.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
  });

  test("inventory events are tenant-scoped", async () => {
    const rows = await asA().inventoryEvents.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productId).toBe(fixtures.productA);
  });

  test("carts are tenant-scoped", async () => {
    expect((await asA().carts.findMany()).map((r) => r.id)).toEqual([fixtures.cartA]);
  });

  test("cart items are tenant-scoped", async () => {
    const rows = await asB().cartItems.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cartId).toBe(fixtures.cartB);
  });

  test("payments are tenant-scoped", async () => {
    const rows = await asA().payments.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderId).toBe(fixtures.orderA);
  });

  test("shipping rates are tenant-scoped", async () => {
    expect((await asA().shippingRates.findMany())[0]?.carrier).toBe("auspost");
    expect((await asB().shippingRates.findMany())[0]?.carrier).toBe("sendle");
  });

  test("activity logs are tenant-scoped", async () => {
    expect(await asA().activityLogs.count()).toBe(1);
  });

  test("feature flags are tenant-scoped", async () => {
    const rows = await asA().featureFlags.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });
});

describe("tenant isolation — writes", () => {
  test("insert stamps the caller's tenantId", async () => {
    const row = await asA().products.insert({ sku: "A-002", name: "M10 Bolt", unitPriceCents: 1500 });
    expect(row.tenantId).toBe(TENANT_A);
  });

  test("insert with a foreign tenantId is refused", async () => {
    await expect(
      asA().products.insert({ tenantId: TENANT_B, sku: "X-1", name: "Smuggled", unitPriceCents: 1 }),
    ).rejects.toThrow(TenantScopeError);
  });

  test("updateById cannot touch another tenant's row", async () => {
    const updated = await asA().products.updateById(fixtures.productB, { name: "Hijacked" });
    expect(updated).toBeUndefined();
    const untouched = await db.select().from(products).where(eq(products.id, fixtures.productB));
    expect(untouched[0]?.name).toBe("Epoxy 500ml");
  });

  test("update cannot re-assign tenantId", async () => {
    await asA().products.updateById(fixtures.productA, { tenantId: TENANT_B, name: "Renamed" });
    const row = await db.select().from(products).where(eq(products.id, fixtures.productA));
    expect(row[0]?.tenantId).toBe(TENANT_A);
    expect(row[0]?.name).toBe("Renamed");
  });

  test("deleteById cannot delete another tenant's row", async () => {
    expect(await asA().products.deleteById(fixtures.productB)).toBeUndefined();
    expect(await db.select().from(products).where(eq(products.id, fixtures.productB))).toHaveLength(1);
  });

  /**
   * Uses a leaf table. `products` is referenced by price tiers, inventory events, cart items
   * and order line items, so deleting a seeded product trips a foreign-key violation — it did
   * under Postgres too, since the old Prisma schema declared no referential actions and so got
   * Prisma's `Restrict` default. What is under test here is the guard's delete scoping, not
   * referential integrity, so the target is a row nothing else points at.
   */
  test("deleteById removes the caller's own row", async () => {
    expect((await asA().featureFlags.deleteById("flag_a"))?.id).toBe("flag_a");
    expect(await asA().featureFlags.count()).toBe(0);
    // Tenant B's flag is untouched.
    expect(await db.select().from(featureFlags)).toHaveLength(1);
  });
});

describe("order line items — scoped through the parent order", () => {
  test("tenant A sees only its own line items", async () => {
    const rows = await asA().orderLineItems.findMany();
    expect(rows.map((r) => r.id)).toEqual([fixtures.lineItemA]);
  });

  test("a line item on another tenant's order is not readable by id", async () => {
    expect(await asA().orderLineItems.findById(fixtures.lineItemB)).toBeUndefined();
    expect(await asB().orderLineItems.findById(fixtures.lineItemB)).toBeDefined();
  });

  test("inserting into another tenant's order is refused", async () => {
    await expect(
      asA().orderLineItems.insert({
        orderId: fixtures.orderB,
        productId: fixtures.productB,
        quantity: 1,
        unitPriceCents: 1,
        totalPriceCents: 1,
      }),
    ).rejects.toThrow(TenantScopeError);
  });

  test("inserting into the caller's own order succeeds", async () => {
    const row = await asA().orderLineItems.insert({
      orderId: fixtures.orderA,
      productId: fixtures.productA,
      quantity: 3,
      unitPriceCents: 1250,
      totalPriceCents: 3750,
    });
    expect(row.orderId).toBe(fixtures.orderA);
    expect(await asA().orderLineItems.count()).toBe(2);
  });
});

describe("fail closed", () => {
  test("an unresolved request sees no products", async () => {
    expect(await scopedDb(ctxAnon, db).products.findMany()).toHaveLength(0);
  });

  test("an unresolved request cannot insert", async () => {
    await expect(
      scopedDb(ctxAnon, db).products.insert({ sku: "N-1", name: "Nobody", unitPriceCents: 1 }),
    ).rejects.toThrow(TenantScopeError);
  });

  test("every generic helper carries a scope predicate", () => {
    const scoped = scopedDb(ctxA, db) as unknown as Record<string, { scope?: unknown }>;
    const names = [
      "companies",
      "categories",
      "products",
      "inventoryEvents",
      "priceTiers",
      "orders",
      "carts",
      "cartItems",
      "payments",
      "shippingRates",
      "activityLogs",
      "featureFlags",
    ];
    expect(names).toHaveLength(12);
    for (const name of names) expect(scoped[name]?.scope).toBeDefined();
  });
});
