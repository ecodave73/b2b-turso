/**
 * Phase 3 services — catalogue, inventory, pricing, orders, cart, shipping.
 *
 * Same shape as middleware-auth.test.ts and deliberately unmocked: real Better Auth sessions,
 * real `call()` through the real middleware chain, real scoped database. What is under test is
 * not "does this function return the right number" but "does this procedure, invoked the way an
 * HTTP request invokes it, produce the right number for the right tenant and refuse everyone
 * else". Three of the four bugs found in phase 1 would have passed a unit test of the service
 * function in isolation.
 *
 * Fixtures are written with the RAW module client on purpose — a test that seeds through the
 * guard cannot prove the guard is what is doing the filtering.
 *
 * Every money assertion is in CENTS and every tax rate in BASIS POINTS. A float anywhere in an
 * expected value is a bug in the test.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { call, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import {
  activityLogs,
  cartItems,
  categories,
  inventoryEvents,
  orderLineItems,
  orders as ordersTable,
  priceTiers,
  products,
  shippingRates,
  tenants,
  users,
} from "../src/api/database/schema";
import { cart } from "../src/api/routes/cart";
import { catalog } from "../src/api/routes/catalog";
import { inventory } from "../src/api/routes/inventory";
import { orders } from "../src/api/routes/orders";
import { pricing } from "../src/api/routes/pricing";
import { shipping } from "../src/api/routes/shipping";
import { ORDER_TRANSITIONS, type OrderStatus } from "../src/api/services/orders";
import type { RequestContext, Role } from "../src/api/tenant/context";
import { withScopedTransaction } from "../src/api/tenant/guard";
import { auth } from "../src/api/auth";
import { migrateModuleDb, moduleDb, resetModuleDb } from "./helpers/module-db";

const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_bravo";
const PASSWORD = "correct-horse-battery-staple";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function cookieHeader(headers: Headers): string {
  const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  return all
    .filter(Boolean)
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

interface Caller {
  id: string;
  headers: Headers;
  ctx: RequestContext;
}

/** A signed-up user, patched into a tenant and role (both are `input: false` on the auth model). */
async function signUp(email: string, tenantId: string | null, role: Role): Promise<Caller> {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: email.split("@")[0] },
    returnHeaders: true,
  });
  const id = response.user.id;
  await moduleDb.update(users).set({ tenantId, role }).where(eq(users.id, id));
  return {
    id,
    headers: new Headers({ host: "localhost:4200", cookie: cookieHeader(headers) }),
    ctx: { userId: id, tenantId, role },
  };
}

/** `any` is deliberate — these are procedures on four different bases with four input shapes. */
async function invoke<T>(procedure: any, input: unknown, caller: Caller): Promise<T> {
  return (await call(procedure, input, { context: { headers: caller.headers } })) as T;
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

// ---------------------------------------------------------------------------
// Fixtures — raw client, so the guard is never the thing that seeded the data
// ---------------------------------------------------------------------------

let adminA: Caller;
let staffA: Caller;
let clientA: Caller;
let adminB: Caller;

interface ProductSeed {
  tenantId?: string;
  sku?: string;
  name?: string;
  unitPriceCents?: number;
  taxRateBp?: number;
  moq?: number;
  isActive?: boolean;
  categoryId?: string | null;
}

let productSeq = 0;

async function seedProduct(seed: ProductSeed = {}) {
  productSeq += 1;
  const row = {
    id: `product_${productSeq}`,
    tenantId: seed.tenantId ?? TENANT_A,
    sku: seed.sku ?? `SKU-${productSeq}`,
    name: seed.name ?? `Product ${productSeq}`,
    unitPriceCents: seed.unitPriceCents ?? 1000,
    taxRateBp: seed.taxRateBp ?? 1000,
    moq: seed.moq ?? 1,
    isActive: seed.isActive ?? true,
    categoryId: seed.categoryId ?? null,
    images: [] as string[],
  };
  await moduleDb.insert(products).values(row);
  return row;
}

async function seedTier(productId: string, minQty: number, maxQty: number | null, unitPriceCents: number, tenantId = TENANT_A) {
  const [row] = await moduleDb
    .insert(priceTiers)
    .values({ tenantId, productId, minQty, maxQty, unitPriceCents })
    .returning();
  return row;
}

async function seedOrder(status: OrderStatus, tenantId = TENANT_A, userId = adminA.id) {
  const [row] = await moduleDb
    .insert(ordersTable)
    .values({
      tenantId,
      orderNumber: `ORD-TEST-${Math.random().toString().slice(2, 8)}`,
      userId,
      status,
      subtotalCents: 1000,
      taxTotalCents: 100,
      totalCents: 1100,
    })
    .returning();
  return row;
}

beforeAll(async () => {
  await migrateModuleDb();
});

beforeEach(async () => {
  await resetModuleDb();
  productSeq = 0;
  await moduleDb.insert(tenants).values([
    { id: TENANT_A, subdomain: "alpha", name: "Alpha Supply Co", plan: "professional" },
    { id: TENANT_B, subdomain: "bravo", name: "Bravo Wholesale", plan: "starter" },
  ]);
  adminA = await signUp("admin-a@example.com", TENANT_A, "TENANT_ADMIN");
  staffA = await signUp("staff-a@example.com", TENANT_A, "TENANT_STAFF");
  clientA = await signUp("client-a@example.com", TENANT_A, "TENANT_CLIENT");
  adminB = await signUp("admin-b@example.com", TENANT_B, "TENANT_ADMIN");
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe("catalog", () => {
  test("staff create a product; the tenant is stamped, not supplied", async () => {
    const created = await invoke<{ id: string; sku: string }>(
      catalog.create,
      { sku: "WIDGET-1", name: "Widget", unitPriceCents: 2500, taxRateBp: 1000, moq: 5 },
      staffA,
    );

    const row = await moduleDb.select().from(products).where(eq(products.id, created.id));
    expect(row[0].tenantId).toBe(TENANT_A);
    expect(row[0].unitPriceCents).toBe(2500);
    expect(row[0].moq).toBe(5);
  });

  test("a client cannot create a product", async () => {
    await expectRejection(
      invoke(catalog.create, { sku: "NOPE", name: "Nope", unitPriceCents: 100 }, clientA),
      "FORBIDDEN",
    );
  });

  test("duplicate SKU inside a tenant is refused", async () => {
    await seedProduct({ sku: "DUP-1" });
    await expectRejection(
      invoke(catalog.create, { sku: "DUP-1", name: "Clash", unitPriceCents: 100 }, staffA),
      "CONFLICT",
      /already exists/i,
    );
  });

  test("the same SKU in another tenant is not a duplicate", async () => {
    await seedProduct({ tenantId: TENANT_B, sku: "SHARED-SKU" });
    const created = await invoke<{ id: string }>(
      catalog.create,
      { sku: "SHARED-SKU", name: "Ours", unitPriceCents: 100 },
      staffA,
    );
    expect(created.id).toBeTruthy();
  });

  test("list filters by search and isActive, and reports derived stock on request", async () => {
    const bolt = await seedProduct({ name: "Hex Bolt M8" });
    await seedProduct({ name: "Cable Tie", isActive: false });
    await moduleDb.insert(inventoryEvents).values([
      { tenantId: TENANT_A, productId: bolt.id, eventType: "RECEIVED", quantity: 100, createdBy: staffA.id },
      { tenantId: TENANT_A, productId: bolt.id, eventType: "SOLD", quantity: -40, createdBy: staffA.id },
    ]);

    const searched = await invoke<{ id: string; stockOnHand: number | null }[]>(
      catalog.list,
      { search: "bolt", withStock: true },
      clientA,
    );
    expect(searched).toHaveLength(1);
    expect(searched[0].id).toBe(bolt.id);
    expect(searched[0].stockOnHand).toBe(60);

    const active = await invoke<unknown[]>(catalog.list, { isActive: true }, clientA);
    expect(active).toHaveLength(1);
  });

  test("get returns the category and price tiers, cheapest break first", async () => {
    const [category] = await moduleDb
      .insert(categories)
      .values({ tenantId: TENANT_A, name: "Fasteners", slug: "fasteners" })
      .returning();
    const product = await seedProduct({ categoryId: category.id });
    await seedTier(product.id, 100, null, 700);
    await seedTier(product.id, 50, 99, 800);

    const found = await invoke<{
      category: { slug: string } | null;
      priceTiers: { minQty: number }[];
    }>(catalog.get, { id: product.id }, clientA);

    expect(found.category?.slug).toBe("fasteners");
    expect(found.priceTiers.map((tier) => tier.minQty)).toEqual([50, 100]);
  });

  test("archive is a soft delete — the row survives for order history", async () => {
    const product = await seedProduct();
    await invoke(catalog.archive, { id: product.id }, staffA);

    const row = await moduleDb.select().from(products).where(eq(products.id, product.id));
    expect(row).toHaveLength(1);
    expect(row[0].isActive).toBe(false);
  });

  test("cross-tenant: another tenant's product is invisible to read and to write", async () => {
    const theirs = await seedProduct({ tenantId: TENANT_B });

    await expectRejection(invoke(catalog.get, { id: theirs.id }, adminA), "NOT_FOUND");
    await expectRejection(invoke(catalog.archive, { id: theirs.id }, adminA), "NOT_FOUND");
    expect(await invoke<unknown[]>(catalog.list, {}, adminA)).toHaveLength(0);

    const stillActive = await moduleDb.select().from(products).where(eq(products.id, theirs.id));
    expect(stillActive[0].isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe("inventory", () => {
  test("stock is derived from mixed events, never stored", async () => {
    const product = await seedProduct();

    await invoke(inventory.record, { productId: product.id, eventType: "RECEIVED", quantity: 100 }, staffA);
    await invoke(inventory.record, { productId: product.id, eventType: "SOLD", quantity: -30 }, staffA);
    await invoke(inventory.record, { productId: product.id, eventType: "RETURNED", quantity: 5 }, staffA);
    const last = await invoke<{ stockOnHand: number }>(
      inventory.record,
      { productId: product.id, eventType: "ADJUSTED", quantity: -7 },
      staffA,
    );

    expect(last.stockOnHand).toBe(68);
    const read = await invoke<{ stockOnHand: number }>(inventory.stock, { productId: product.id }, clientA);
    expect(read.stockOnHand).toBe(68);
  });

  test("history is newest first and an event is audited", async () => {
    const product = await seedProduct();
    await invoke(inventory.record, { productId: product.id, eventType: "RECEIVED", quantity: 10 }, staffA);
    await invoke(inventory.record, { productId: product.id, eventType: "SOLD", quantity: -2 }, staffA);

    const history = await invoke<{ eventType: string; quantity: number }[]>(
      inventory.history,
      { productId: product.id },
      clientA,
    );
    expect(history).toHaveLength(2);
    // Newest first: the SOLD event was recorded second, so it must lead.
    expect(history.map((event) => event.eventType)).toEqual(["SOLD", "RECEIVED"]);
    expect(history[0].quantity).toBe(-2);

    const logs = await moduleDb
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.tenantId, TENANT_A), eq(activityLogs.action, "inventory.event_recorded")));
    expect(logs).toHaveLength(2);
  });

  test("checkAvailability compares against derived stock", async () => {
    const product = await seedProduct();
    await moduleDb
      .insert(inventoryEvents)
      .values({
        tenantId: TENANT_A,
        productId: product.id,
        eventType: "RECEIVED",
        quantity: 4,
        createdBy: staffA.id,
      });

    expect(
      (await invoke<{ available: boolean }>(inventory.checkAvailability, { productId: product.id, quantity: 4 }, clientA))
        .available,
    ).toBe(true);
    expect(
      (await invoke<{ available: boolean }>(inventory.checkAvailability, { productId: product.id, quantity: 5 }, clientA))
        .available,
    ).toBe(false);
  });

  test("a client cannot record an event", async () => {
    const product = await seedProduct();
    await expectRejection(
      invoke(inventory.record, { productId: product.id, eventType: "RECEIVED", quantity: 1 }, clientA),
      "FORBIDDEN",
    );
  });

  test("cross-tenant: events cannot be appended to, or read from, another tenant's product", async () => {
    const theirs = await seedProduct({ tenantId: TENANT_B });
    await moduleDb
      .insert(inventoryEvents)
      .values({
        tenantId: TENANT_B,
        productId: theirs.id,
        eventType: "RECEIVED",
        quantity: 500,
        createdBy: adminB.id,
      });

    await expectRejection(
      invoke(inventory.record, { productId: theirs.id, eventType: "RECEIVED", quantity: 1 }, staffA),
      "NOT_FOUND",
    );
    await expectRejection(invoke(inventory.stock, { productId: theirs.id }, adminA), "NOT_FOUND");

    // Even the batch read, which does not check the product first, must not leak the count.
    const batch = await invoke<{ productId: string; stockOnHand: number }[]>(
      inventory.stockFor,
      { productIds: [theirs.id] },
      adminA,
    );
    expect(batch[0].stockOnHand).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("pricing", () => {
  test("base price applies when no tier contains the quantity", async () => {
    const product = await seedProduct({ unitPriceCents: 1000 });
    await seedTier(product.id, 50, null, 800);

    const quote = await invoke<{ unitPriceCents: number; tierApplied: string | null }>(
      pricing.quote,
      { productId: product.id, quantity: 10 },
      clientA,
    );
    expect(quote.unitPriceCents).toBe(1000);
    expect(quote.tierApplied).toBeNull();
  });

  test("the deepest containing tier wins, exactly at the boundaries", async () => {
    const product = await seedProduct({ unitPriceCents: 1000 });
    await seedTier(product.id, 50, 99, 800);
    await seedTier(product.id, 100, null, 700);

    const priceAt = async (quantity: number) =>
      (await invoke<{ unitPriceCents: number }>(pricing.quote, { productId: product.id, quantity }, clientA))
        .unitPriceCents;

    expect(await priceAt(49)).toBe(1000);
    expect(await priceAt(50)).toBe(800);
    expect(await priceAt(99)).toBe(800);
    expect(await priceAt(100)).toBe(700);
    expect(await priceAt(5000)).toBe(700);
  });

  test("tax is integer basis points on the line total", async () => {
    const product = await seedProduct({ unitPriceCents: 1999, taxRateBp: 1000 });

    const quote = await invoke<{ totalPriceCents: number; taxCents: number; totalIncTaxCents: number }>(
      pricing.quote,
      { productId: product.id, quantity: 3 },
      clientA,
    );
    expect(quote.totalPriceCents).toBe(5997);
    expect(quote.taxCents).toBe(600); // 599.7 rounded once, not carried as a float
    expect(quote.totalIncTaxCents).toBe(6597);
  });

  test("a quantity below MOQ is refused", async () => {
    const product = await seedProduct({ moq: 10 });
    await expectRejection(
      invoke(pricing.quote, { productId: product.id, quantity: 9 }, clientA),
      "BAD_REQUEST",
      /minimum order quantity/i,
    );
  });

  test("overlapping tiers are refused at write time", async () => {
    const product = await seedProduct();
    await invoke(pricing.createTier, { productId: product.id, minQty: 50, maxQty: 99, unitPriceCents: 800 }, staffA);

    await expectRejection(
      invoke(pricing.createTier, { productId: product.id, minQty: 90, maxQty: 150, unitPriceCents: 700 }, staffA),
      "CONFLICT",
    );
    // An open-ended tier overlaps everything above its floor.
    await expectRejection(
      invoke(pricing.createTier, { productId: product.id, minQty: 60, maxQty: null, unitPriceCents: 700 }, staffA),
      "CONFLICT",
    );
  });

  test("adjacent tiers are allowed", async () => {
    const product = await seedProduct();
    await invoke(pricing.createTier, { productId: product.id, minQty: 50, maxQty: 99, unitPriceCents: 800 }, staffA);
    const next = await invoke<{ id: string }>(
      pricing.createTier,
      { productId: product.id, minQty: 100, maxQty: null, unitPriceCents: 700 },
      staffA,
    );
    expect(next.id).toBeTruthy();
  });

  test("a client can read tiers but cannot write them", async () => {
    const product = await seedProduct();
    await seedTier(product.id, 50, null, 800);

    expect(await invoke<unknown[]>(pricing.tiers, { productId: product.id }, clientA)).toHaveLength(1);
    await expectRejection(
      invoke(pricing.createTier, { productId: product.id, minQty: 5, maxQty: 9, unitPriceCents: 1 }, clientA),
      "FORBIDDEN",
    );
  });

  test("cross-tenant: tiers on another tenant's product are neither readable nor deletable", async () => {
    const theirs = await seedProduct({ tenantId: TENANT_B });
    const tier = await seedTier(theirs.id, 10, null, 500, TENANT_B);

    await expectRejection(invoke(pricing.tiers, { productId: theirs.id }, adminA), "NOT_FOUND");
    await expectRejection(invoke(pricing.deleteTier, { id: tier.id }, adminA), "NOT_FOUND");
    await expectRejection(invoke(pricing.quote, { productId: theirs.id, quantity: 10 }, adminA), "NOT_FOUND");

    const survivors = await moduleDb.select().from(priceTiers).where(eq(priceTiers.id, tier.id));
    expect(survivors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

describe("orders", () => {
  test("create prices the lines on the server, in cents", async () => {
    const product = await seedProduct({ unitPriceCents: 1999, taxRateBp: 1000 });

    const created = await invoke<{ id: string; orderNumber: string; totalCents: number }>(
      orders.create,
      { items: [{ productId: product.id, quantity: 3 }] },
      clientA,
    );

    expect(created.orderNumber).toMatch(/^ORD-\d{6}-\d{4}$/);
    expect(created.totalCents).toBe(6597);

    const [row] = await moduleDb.select().from(ordersTable).where(eq(ordersTable.id, created.id));
    expect(row.status).toBe("DRAFT");
    expect(row.subtotalCents).toBe(5997);
    expect(row.taxTotalCents).toBe(600);

    const lines = await moduleDb.select().from(orderLineItems).where(eq(orderLineItems.orderId, created.id));
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceCents).toBe(1999);
    expect(lines[0].totalPriceCents).toBe(5997);
  });

  test("create applies volume tiers and refuses below MOQ", async () => {
    const product = await seedProduct({ unitPriceCents: 1000, taxRateBp: 0, moq: 10 });
    await seedTier(product.id, 50, null, 800);

    const created = await invoke<{ totalCents: number }>(
      orders.create,
      { items: [{ productId: product.id, quantity: 50 }] },
      clientA,
    );
    expect(created.totalCents).toBe(40_000);

    await expectRejection(
      invoke(orders.create, { items: [{ productId: product.id, quantity: 9 }] }, clientA),
      "BAD_REQUEST",
      /minimum order quantity/i,
    );
  });

  test("an order cannot reference another tenant's product", async () => {
    const theirs = await seedProduct({ tenantId: TENANT_B });
    await expectRejection(
      invoke(orders.create, { items: [{ productId: theirs.id, quantity: 1 }] }, adminA),
      "BAD_REQUEST",
      /not found or not available/i,
    );
    expect(await moduleDb.select().from(ordersTable)).toHaveLength(0);
  });

  test("list reports the line item count and filters by status", async () => {
    const product = await seedProduct();
    await invoke(orders.create, { items: [{ productId: product.id, quantity: 1 }] }, clientA);
    await seedOrder("PENDING");

    const all = await invoke<{ status: string; itemCount: number }[]>(orders.list, {}, adminA);
    expect(all).toHaveLength(2);
    const draft = all.find((order) => order.status === "DRAFT");
    expect(draft?.itemCount).toBe(1);

    const pending = await invoke<unknown[]>(orders.list, { status: "PENDING" }, adminA);
    expect(pending).toHaveLength(1);
  });

  test("get returns line items with current catalogue names alongside the price snapshot", async () => {
    const product = await seedProduct({ name: "Hex Bolt M8", unitPriceCents: 500, taxRateBp: 0 });
    const created = await invoke<{ id: string }>(
      orders.create,
      { items: [{ productId: product.id, quantity: 2 }] },
      clientA,
    );

    // The catalogue moves on; the order does not.
    await moduleDb.update(products).set({ unitPriceCents: 900, name: "Hex Bolt M8 (v2)" }).where(eq(products.id, product.id));

    const found = await invoke<{ lineItems: { name: string | null; unitPriceCents: number }[] }>(
      orders.get,
      { id: created.id },
      clientA,
    );
    expect(found.lineItems[0].unitPriceCents).toBe(500);
    expect(found.lineItems[0].name).toBe("Hex Bolt M8 (v2)");
  });

  test("every legal transition in the table is accepted", async () => {
    for (const [from, allowed] of Object.entries(ORDER_TRANSITIONS) as [OrderStatus, OrderStatus[]][]) {
      for (const to of allowed) {
        const order = await seedOrder(from);
        const result = await invoke<{ status: string }>(orders.updateStatus, { id: order.id, status: to }, staffA);
        expect(result.status).toBe(to);
      }
    }
  });

  test("an illegal transition is refused and names what was allowed", async () => {
    const shipped = await seedOrder("SHIPPED");
    await expectRejection(
      invoke(orders.updateStatus, { id: shipped.id, status: "CANCELLED" }, staffA),
      "BAD_REQUEST",
      /Allowed: INVOICED/,
    );

    const closed = await seedOrder("CLOSED");
    await expectRejection(
      invoke(orders.updateStatus, { id: closed.id, status: "PAID" }, staffA),
      "BAD_REQUEST",
      /Allowed: none/,
    );
  });

  test("a status change is audited with both ends of the transition", async () => {
    const order = await seedOrder("DRAFT");
    await invoke(orders.updateStatus, { id: order.id, status: "PENDING" }, staffA);

    const [log] = await moduleDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.action, "order.status_changed"));
    expect(log.details).toEqual({ from: "DRAFT", to: "PENDING" });
  });

  test("a client cannot move an order through the lifecycle", async () => {
    const order = await seedOrder("DRAFT");
    await expectRejection(invoke(orders.updateStatus, { id: order.id, status: "PENDING" }, clientA), "FORBIDDEN");
  });

  test("cross-tenant: another tenant's order is invisible and immovable", async () => {
    const theirs = await seedOrder("DRAFT", TENANT_B, adminB.id);

    await expectRejection(invoke(orders.get, { id: theirs.id }, adminA), "NOT_FOUND");
    await expectRejection(invoke(orders.updateStatus, { id: theirs.id, status: "PENDING" }, adminA), "NOT_FOUND");
    expect(await invoke<unknown[]>(orders.list, {}, adminA)).toHaveLength(0);

    const [untouched] = await moduleDb.select().from(ordersTable).where(eq(ordersTable.id, theirs.id));
    expect(untouched.status).toBe("DRAFT");
  });
});

// ---------------------------------------------------------------------------
// Cart and checkout
// ---------------------------------------------------------------------------

describe("cart", () => {
  test("adding re-prices the combined quantity across a tier boundary", async () => {
    const product = await seedProduct({ unitPriceCents: 1000, taxRateBp: 0 });
    await seedTier(product.id, 50, null, 800);

    const first = await invoke<{ unitPriceCents: number }>(
      cart.addItem,
      { productId: product.id, quantity: 20 },
      clientA,
    );
    expect(first.unitPriceCents).toBe(1000);

    const second = await invoke<{ quantity: number; unitPriceCents: number }>(
      cart.addItem,
      { productId: product.id, quantity: 40 },
      clientA,
    );
    expect(second.quantity).toBe(60);
    expect(second.unitPriceCents).toBe(800);

    const summary = await invoke<{ lines: unknown[]; subtotalCents: number }>(cart.summary, {}, clientA);
    expect(summary.lines).toHaveLength(1);
    expect(summary.subtotalCents).toBe(48_000);
  });

  test("the summary totals in cents, with tax per line and shipping added on", async () => {
    const a = await seedProduct({ unitPriceCents: 1999, taxRateBp: 1000 });
    const b = await seedProduct({ unitPriceCents: 500, taxRateBp: 0 });
    await invoke(cart.addItem, { productId: a.id, quantity: 3 }, clientA);
    await invoke(cart.addItem, { productId: b.id, quantity: 2 }, clientA);

    const summary = await invoke<{
      itemCount: number;
      subtotalCents: number;
      taxTotalCents: number;
      shippingCostCents: number;
      totalCents: number;
      currency: string;
    }>(cart.summary, { shippingCostCents: 1500 }, clientA);

    expect(summary.itemCount).toBe(5);
    expect(summary.subtotalCents).toBe(6997);
    expect(summary.taxTotalCents).toBe(600);
    expect(summary.totalCents).toBe(9097);
    expect(summary.currency).toBe("AUD");
  });

  test("quantity zero removes the line", async () => {
    const product = await seedProduct();
    const item = await invoke<{ id: string }>(cart.addItem, { productId: product.id, quantity: 2 }, clientA);

    const result = await invoke<{ removed: boolean }>(
      cart.updateItemQuantity,
      { cartItemId: item.id, quantity: 0 },
      clientA,
    );
    expect(result.removed).toBe(true);
    expect(await moduleDb.select().from(cartItems)).toHaveLength(0);
  });

  test("a product archived after it was added drops out of the total instead of blocking it", async () => {
    const keep = await seedProduct({ unitPriceCents: 1000, taxRateBp: 0 });
    const archived = await seedProduct({ unitPriceCents: 5000, taxRateBp: 0 });
    await invoke(cart.addItem, { productId: keep.id, quantity: 1 }, clientA);
    await invoke(cart.addItem, { productId: archived.id, quantity: 1 }, clientA);

    await moduleDb.update(products).set({ isActive: false }).where(eq(products.id, archived.id));

    const summary = await invoke<{ lines: unknown[]; subtotalCents: number }>(cart.summary, {}, clientA);
    expect(summary.lines).toHaveLength(1);
    expect(summary.subtotalCents).toBe(1000);
  });

  test("checkout creates a PENDING order, snapshots the lines, and empties the cart", async () => {
    const product = await seedProduct({ name: "Hex Bolt M8", sku: "HB-M8", unitPriceCents: 1999, taxRateBp: 1000 });
    await invoke(cart.addItem, { productId: product.id, quantity: 3 }, clientA);

    const order = await invoke<{ id: string; status: string; totalCents: number; orderNumber: string }>(
      cart.checkout,
      { shippingCostCents: 1500, poNumber: "PO-42" },
      clientA,
    );

    expect(order.status).toBe("PENDING");
    expect(order.totalCents).toBe(8097); // 5997 + 600 tax + 1500 shipping

    const [row] = await moduleDb.select().from(ordersTable).where(eq(ordersTable.id, order.id));
    expect(row.poNumber).toBe("PO-42");
    expect(row.shippingCostCents).toBe(1500);
    expect(row.userId).toBe(clientA.id);

    const [line] = await moduleDb.select().from(orderLineItems).where(eq(orderLineItems.orderId, order.id));
    expect(line.metadata).toEqual({ sku: "HB-M8", name: "Hex Bolt M8", taxRateBp: 1000, taxCents: 600 });

    expect(await moduleDb.select().from(cartItems)).toHaveLength(0);

    const logs = await moduleDb.select().from(activityLogs).where(eq(activityLogs.action, "cart.checked_out"));
    expect(logs).toHaveLength(1);
  });

  test("checking out an empty cart is refused", async () => {
    await expectRejection(invoke(cart.checkout, {}, clientA), "BAD_REQUEST", /empty/i);
  });

  test("carts are per user, not per tenant", async () => {
    const product = await seedProduct();
    await invoke(cart.addItem, { productId: product.id, quantity: 2 }, clientA);

    const other = await invoke<{ lines: unknown[] }>(cart.summary, {}, adminA);
    expect(other.lines).toHaveLength(0);
  });

  test("cross-tenant: a buyer cannot add another tenant's product to their cart", async () => {
    const theirs = await seedProduct({ tenantId: TENANT_B });
    await expectRejection(invoke(cart.addItem, { productId: theirs.id, quantity: 1 }, clientA), "NOT_FOUND");
    expect(await moduleDb.select().from(cartItems)).toHaveLength(0);
  });

  test("cross-tenant: one tenant's cart item cannot be touched from another tenant", async () => {
    const theirs = await seedProduct({ tenantId: TENANT_B });
    await invoke(cart.addItem, { productId: theirs.id, quantity: 1 }, adminB);
    const [item] = await moduleDb.select().from(cartItems);

    await expectRejection(invoke(cart.removeItem, { cartItemId: item.id }, clientA), "NOT_FOUND");
    await expectRejection(
      invoke(cart.updateItemQuantity, { cartItemId: item.id, quantity: 9 }, clientA),
      "NOT_FOUND",
    );
    expect(await moduleDb.select().from(cartItems)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

describe("shipping", () => {
  test("a parcel quote returns only fallback rates, cheapest first", async () => {
    await moduleDb.insert(shippingRates).values([
      { tenantId: TENANT_A, carrier: "auspost", serviceName: "Express", rateCents: 2200, isFallback: true },
      { tenantId: TENANT_A, carrier: "auspost", serviceName: "Parcel Post", rateCents: 1100, isFallback: true },
      { tenantId: TENANT_A, carrier: "sendle", serviceName: "Negotiated", rateCents: 100, isFallback: false },
    ]);

    const rates = await invoke<{ serviceName: string; rateCents: number; isLive: boolean }[]>(
      shipping.rates,
      { weightGrams: 2500 },
      clientA,
    );
    expect(rates.map((rate) => rate.rateCents)).toEqual([1100, 2200]);
    expect(rates.every((rate) => rate.isLive === false)).toBe(true);
  });

  test("staff create and delete rates; clients cannot", async () => {
    const created = await invoke<{ id: string }>(
      shipping.create,
      { carrier: "sendle", serviceName: "Standard", rateCents: 950, isFallback: true },
      staffA,
    );
    expect(await invoke<unknown[]>(shipping.list, undefined, clientA)).toHaveLength(1);

    await expectRejection(invoke(shipping.delete, { id: created.id }, clientA), "FORBIDDEN");
    await invoke(shipping.delete, { id: created.id }, staffA);
    expect(await moduleDb.select().from(shippingRates)).toHaveLength(0);
  });

  test("cross-tenant: rates are not visible or deletable across tenants", async () => {
    const [theirs] = await moduleDb
      .insert(shippingRates)
      .values({ tenantId: TENANT_B, carrier: "auspost", serviceName: "Express", rateCents: 2200, isFallback: true })
      .returning();

    expect(await invoke<unknown[]>(shipping.list, undefined, adminA)).toHaveLength(0);
    expect(await invoke<unknown[]>(shipping.rates, { weightGrams: 100 }, adminA)).toHaveLength(0);
    await expectRejection(invoke(shipping.delete, { id: theirs.id }, adminA), "NOT_FOUND");
    expect(await moduleDb.select().from(shippingRates)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe("withScopedTransaction", () => {
  test("a failure rolls the whole unit of work back", async () => {
    await expect(
      withScopedTransaction(adminA.ctx, async (tx) => {
        await tx.products.insert({ sku: "ROLLED-BACK", name: "Rolled back", unitPriceCents: 100, tenantId: TENANT_A });
        await tx.activityLogs.insert({
          tenantId: TENANT_A,
          userId: adminA.id,
          action: "test.boom",
          entity: "product",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await moduleDb.select().from(products).where(eq(products.sku, "ROLLED-BACK"))).toHaveLength(0);
    expect(await moduleDb.select().from(activityLogs).where(eq(activityLogs.action, "test.boom"))).toHaveLength(0);
  });

  test("the transaction is still scoped — it cannot be used to write into another tenant", async () => {
    await expect(
      withScopedTransaction(adminA.ctx, async (tx) => {
        await tx.products.insert({
          tenantId: TENANT_B,
          sku: "SMUGGLED",
          name: "Smuggled",
          unitPriceCents: 100,
        });
      }),
    ).rejects.toThrow(/Refusing to write/);

    expect(await moduleDb.select().from(products)).toHaveLength(0);
  });
});
