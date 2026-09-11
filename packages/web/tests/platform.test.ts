/**
 * Phase 5 — the mothership: platform-wide console, "open as tenant", and the tenant cascade.
 *
 * Same unmocked shape as the rest of the suite: real Better Auth sessions, real `call()`
 * through the real middleware chain, real scoped database, fixtures written with the RAW
 * module client so the guard is never the thing that seeded the data.
 *
 * Three things here are more dangerous than anything tested so far, and each gets its own
 * probes:
 *
 *   1. `platform.*` reads ACROSS tenants on purpose (`platformDb()` → `1 = 1`). The risk is not
 *      a leak, it is the opposite: figures silently narrowing to one tenant when a super admin
 *      happens to be "viewing as". There is a test for exactly that.
 *   2. Every one of the six procedures is a super-admin bypass, so every one gets a
 *      role-refusal probe. A gate that is only tested on the first procedure is a gate that
 *      goes missing on the sixth.
 *   3. `deleteTenantCascade` is the one destructive cross-tenant operation in the system. It is
 *      tested both ways: that it wipes what it should, and that it refuses whom it should —
 *      and that the tenant next door still has all of its rows afterwards.
 *
 * Money in CENTS. A float in an expected value is a bug in the test.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { call, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import {
  activityLogs,
  cartItems,
  carts,
  categories,
  companies,
  featureFlags,
  inventoryEvents,
  orderLineItems,
  orders as ordersTable,
  payments,
  priceTiers,
  products,
  shippingRates,
  tenants,
  users,
} from "../src/api/database/schema";
import { activity } from "../src/api/routes/activity";
import { platform } from "../src/api/routes/platform";
import { session } from "../src/api/routes/session";
import { auth } from "../src/api/auth";
import type { RequestContext, Role } from "../src/api/tenant/context";
import { deleteTenantCascade, TenantScopeError } from "../src/api/tenant/guard";
import { TENANT_PATH_HEADER } from "../src/api/tenant/resolve";
import { migrateModuleDb, moduleDb, resetModuleDb } from "./helpers/module-db";

const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_bravo";
const TENANT_C = "tenant_charlie";
const PASSWORD = "correct-horse-battery-staple";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function cookieHeader(headers: Headers): string {
  const all =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  return all
    .filter(Boolean)
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

interface Caller {
  id: string;
  email: string;
  cookie: string;
  ctx: RequestContext;
}

async function signUp(email: string, tenantId: string | null, role: Role): Promise<Caller> {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: email.split("@")[0] },
    returnHeaders: true,
  });
  const id = response.user.id;
  await moduleDb.update(users).set({ tenantId, role }).where(eq(users.id, id));
  return { id, email, cookie: cookieHeader(headers), ctx: { userId: id, tenantId, role } };
}

function headersFor(caller: Caller | null, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ host: "localhost:4200", ...extra });
  if (caller) headers.set("cookie", caller.cookie);
  return headers;
}

/**
 * Address a tenant the way the web client does — the path the browser is on.
 *
 * preload.ts deletes TENANT_ROOT_DOMAIN and TENANT_DEV_HEADER, so the path prefix is the only
 * addressing strategy live in tests. This is exactly what "open as tenant" does in the browser.
 */
function addressing(subdomain: string): Record<string, string> {
  return { [TENANT_PATH_HEADER]: `/t/${subdomain}/dashboard` };
}

/** `any` is deliberate — these procedures sit on different bases with different input shapes. */
async function invoke<T>(procedure: any, input: unknown, headers: Headers): Promise<T> {
  return (await call(procedure, input, { context: { headers } })) as T;
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

async function expectScopeError(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TenantScopeError);
  expect((thrown as Error).message).toMatch(matcher);
}

// ---------------------------------------------------------------------------
// Return shapes (structural — the procedures are the source of truth)
// ---------------------------------------------------------------------------

interface PlatformStats {
  tenantsTotal: number;
  tenantsActive: number;
  tenantsSuspended: number;
  tenantsSandbox: number;
  tenantsNewThisMonth: number;
  usersTotal: number;
  usersByRole: { role: string; users: number }[];
  ordersTotal: number;
  ordersLast30Days: number;
  gmvCents: number;
  gmvLast30DaysCents: number;
  openValueCents: number;
  currency: string;
  mrrTotalCents: number;
  mrrByPlan: { plan: string; listPriceCents: number; tenants: number; mrrCents: number }[];
  trendDays: number;
  signupTrend: { date: string; tenants: number }[];
  ordersTrend: { date: string; orders: number; revenueCents: number }[];
}

interface TenantRow {
  id: string;
  name: string;
  subdomain: string;
  plan: string;
  isActive: boolean;
  isSandbox: boolean;
  userCount: number;
  productCount: number;
  orderCount: number;
  revenueCents: number;
  mrrCents: number;
  lastActivityAt: Date | null;
}

interface TenantList {
  total: number;
  limit: number;
  offset: number;
  tenants: TenantRow[];
}

interface LogEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  userId: string | null;
  userEmail: string | null;
  createdAt: Date;
}

interface TenantDetail {
  id: string;
  name: string;
  plan: string;
  isActive: boolean;
  squareConnected: boolean;
  billingConnected: boolean;
  userCount: number;
  productCount: number;
  orderCount: number;
  mrrCents: number;
  revenueCents: number;
  openOrderValueCents: number;
  ordersByStatus: { status: string; orders: number; totalCents: number }[];
  users: { id: string; email: string; role: string }[];
  recentOrders: { id: string; orderNumber: string; status: string; totalCents: number }[];
  recentActivity: LogEntry[];
  featureFlags: { id: string; key: string; enabled: boolean }[];
}

interface PlatformFeed {
  total: number;
  entries: (LogEntry & { tenantId: string; tenantName: string | null; tenantSubdomain: string | null })[];
}

interface TenantFeed {
  total: number;
  entries: LogEntry[];
}

interface MutationResult {
  id: string;
  plan: string;
  isActive: boolean;
  changed: boolean;
}

interface SessionCurrent {
  user: { id: string; role: string } | null;
  tenant: { id: string; name: string; subdomain: string } | null;
  isViewingAsTenant: boolean;
  viewingTenant: { id: string; name: string; subdomain: string } | null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let superA: Caller;
let adminA: Caller;
let staffA: Caller;
let adminB: Caller;

let seq = 0;

async function seedProduct(tenantId = TENANT_A) {
  seq += 1;
  const [row] = await moduleDb
    .insert(products)
    .values({
      tenantId,
      sku: `SKU-${seq}`,
      name: `Product ${seq}`,
      unitPriceCents: 1000,
      images: [] as string[],
    })
    .returning();
  return row;
}

async function seedOrder(options: {
  status: string;
  totalCents?: number;
  tenantId?: string;
  userId?: string;
  createdAt?: Date;
}) {
  seq += 1;
  const [row] = await moduleDb
    .insert(ordersTable)
    .values({
      tenantId: options.tenantId ?? TENANT_A,
      orderNumber: `ORD-TEST-${seq}`,
      userId: options.userId ?? adminA.id,
      status: options.status,
      subtotalCents: options.totalCents ?? 1000,
      taxTotalCents: 0,
      totalCents: options.totalCents ?? 1000,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning();
  return row;
}

async function seedLog(options: {
  action: string;
  tenantId?: string;
  userId?: string | null;
  entity?: string;
  createdAt?: Date;
}) {
  const [row] = await moduleDb
    .insert(activityLogs)
    .values({
      tenantId: options.tenantId ?? TENANT_A,
      userId: options.userId === undefined ? adminA.id : options.userId,
      action: options.action,
      entity: options.entity ?? "order",
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning();
  return row;
}

/** One row in every tenant-scoped table — the fixture the cascade is measured against. */
async function seedFullTenant(tenantId: string, userId: string) {
  seq += 1;
  const tag = `${tenantId}-${seq}`;
  const [company] = await moduleDb
    .insert(companies)
    .values({ tenantId, name: `Buyer ${tag}` })
    .returning();
  const [category] = await moduleDb
    .insert(categories)
    .values({ tenantId, name: "Widgets", slug: `widgets-${seq}` })
    .returning();
  const [product] = await moduleDb
    .insert(products)
    .values({
      tenantId,
      categoryId: category.id,
      sku: `SKU-${tag}`,
      name: "Widget",
      unitPriceCents: 2500,
      images: [] as string[],
    })
    .returning();
  await moduleDb
    .insert(inventoryEvents)
    .values({ tenantId, productId: product.id, eventType: "RECEIVED", quantity: 10, createdBy: userId });
  await moduleDb
    .insert(priceTiers)
    .values({ tenantId, productId: product.id, minQty: 1, unitPriceCents: 2500 });
  const [order] = await moduleDb
    .insert(ordersTable)
    .values({
      tenantId,
      orderNumber: `ORD-FULL-${tag}`,
      companyId: company.id,
      userId,
      status: "PAID",
      subtotalCents: 2500,
      taxTotalCents: 250,
      totalCents: 2750,
    })
    .returning();
  await moduleDb
    .insert(orderLineItems)
    .values({ orderId: order.id, productId: product.id, quantity: 1, unitPriceCents: 2500, totalPriceCents: 2500 });
  await moduleDb
    .insert(payments)
    .values({ tenantId, orderId: order.id, amountCents: 2750, method: "stripe", status: "COMPLETED" });
  const [cart] = await moduleDb.insert(carts).values({ tenantId, userId }).returning();
  await moduleDb
    .insert(cartItems)
    .values({ cartId: cart.id, tenantId, productId: product.id, quantity: 2, priceCents: 2500 });
  await moduleDb
    .insert(shippingRates)
    .values({ tenantId, carrier: "auspost", serviceName: "Parcel Post", rateCents: 995 });
  await moduleDb
    .insert(activityLogs)
    .values({ tenantId, userId, action: "order.created", entity: "order", entityId: order.id });
  await moduleDb.insert(featureFlags).values({ tenantId, key: `quotes-${seq}`, enabled: true });
  return { company, category, product, order, cart };
}

async function rowCount(table: any, where: any): Promise<number> {
  return (await moduleDb.select().from(table).where(where)).length;
}

beforeAll(async () => {
  await migrateModuleDb();
});

beforeEach(async () => {
  await resetModuleDb();
  seq = 0;
  await moduleDb.insert(tenants).values([
    { id: TENANT_A, subdomain: "alpha", name: "Alpha Supply Co", plan: "professional" },
    { id: TENANT_B, subdomain: "bravo", name: "Bravo Wholesale", plan: "starter" },
    {
      id: TENANT_C,
      subdomain: "charlie",
      name: "Charlie Sandbox",
      plan: "enterprise",
      isSandbox: true,
      isActive: false,
    },
  ]);
  superA = await signUp("platform@example.com", null, "SUPER_ADMIN");
  adminA = await signUp("admin-a@example.com", TENANT_A, "TENANT_ADMIN");
  staffA = await signUp("staff-a@example.com", TENANT_A, "TENANT_STAFF");
  adminB = await signUp("admin-b@example.com", TENANT_B, "TENANT_ADMIN");
});

// ---------------------------------------------------------------------------
// The gate — every procedure, not just the first one
// ---------------------------------------------------------------------------

describe("platform role gate", () => {
  const probes: [string, unknown][] = [
    ["stats", undefined],
    ["tenants", {}],
    ["tenantDetail", { tenantId: TENANT_A }],
    ["activity", {}],
    ["setTenantActive", { tenantId: TENANT_A, isActive: false }],
    ["updateTenantPlan", { tenantId: TENANT_A, plan: "starter" }],
  ];

  for (const [name, input] of probes) {
    test(`platform.${name} refuses a tenant admin`, async () => {
      const procedure = (platform as Record<string, any>)[name];
      await expectRejection(
        invoke(procedure, input, headersFor(adminA)),
        "FORBIDDEN",
        /Platform administrators only/,
      );
    });

    test(`platform.${name} refuses an anonymous caller`, async () => {
      const procedure = (platform as Record<string, any>)[name];
      await expectRejection(invoke(procedure, input, headersFor(null)), "UNAUTHORIZED");
    });
  }

  test("a refused mutation changes nothing", async () => {
    await expectRejection(
      invoke(platform.setTenantActive, { tenantId: TENANT_A, isActive: false }, headersFor(adminA)),
      "FORBIDDEN",
    );
    const [tenant] = await moduleDb.select().from(tenants).where(eq(tenants.id, TENANT_A));
    expect(tenant.isActive).toBe(true);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_A))).toBe(0);
  });

  test("a tenant staff member is refused too — admin is not the boundary here", async () => {
    await expectRejection(
      invoke(platform.stats, undefined, headersFor(staffA)),
      "FORBIDDEN",
      /Platform administrators only/,
    );
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

describe("platform.stats", () => {
  test("counts tenants, users and plans across the whole platform", async () => {
    const stats = await invoke<PlatformStats>(platform.stats, undefined, headersFor(superA));

    expect(stats.tenantsTotal).toBe(3);
    expect(stats.tenantsActive).toBe(2);
    expect(stats.tenantsSuspended).toBe(1);
    expect(stats.tenantsSandbox).toBe(1);
    expect(stats.tenantsNewThisMonth).toBe(3);

    expect(stats.usersTotal).toBe(4);
    expect(stats.usersByRole).toEqual([
      { role: "SUPER_ADMIN", users: 1 },
      { role: "TENANT_ADMIN", users: 2 },
      { role: "TENANT_STAFF", users: 1 },
    ]);
  });

  test("MRR is list price, and a suspended tenant contributes nothing", async () => {
    const stats = await invoke<PlatformStats>(platform.stats, undefined, headersFor(superA));

    // professional 19_900 + starter 4_900 + suspended enterprise 0
    expect(stats.mrrTotalCents).toBe(24_800);

    const byPlan = new Map(stats.mrrByPlan.map((row) => [row.plan, row]));
    expect(byPlan.get("starter")).toEqual({
      plan: "starter",
      listPriceCents: 4_900,
      tenants: 1,
      mrrCents: 4_900,
    });
    expect(byPlan.get("professional")).toEqual({
      plan: "professional",
      listPriceCents: 19_900,
      tenants: 1,
      mrrCents: 19_900,
    });
    // Still counted as a tenant on the plan; contributes zero while suspended.
    expect(byPlan.get("enterprise")).toEqual({
      plan: "enterprise",
      listPriceCents: 99_900,
      tenants: 1,
      mrrCents: 0,
    });
  });

  test("GMV counts PAID and CLOSED across every tenant; open value is the pipeline", async () => {
    await seedOrder({ status: "PAID", totalCents: 5_000 });
    await seedOrder({ status: "CLOSED", totalCents: 2_500 });
    await seedOrder({ status: "PENDING", totalCents: 900 });
    await seedOrder({ status: "CANCELLED", totalCents: 99_999 });
    await seedOrder({ status: "PAID", totalCents: 1_000, tenantId: TENANT_B, userId: adminB.id });

    const stats = await invoke<PlatformStats>(platform.stats, undefined, headersFor(superA));
    expect(stats.ordersTotal).toBe(5);
    expect(stats.gmvCents).toBe(8_500);
    expect(stats.openValueCents).toBe(900);
    expect(stats.currency).toBe("AUD");
  });

  test("the 30-day figures exclude older orders, which still count all-time", async () => {
    const old = new Date(Date.now() - 60 * 86_400_000);
    await seedOrder({ status: "PAID", totalCents: 700, createdAt: old });
    await seedOrder({ status: "PAID", totalCents: 300 });

    const stats = await invoke<PlatformStats>(platform.stats, undefined, headersFor(superA));
    expect(stats.ordersTotal).toBe(2);
    expect(stats.gmvCents).toBe(1_000);
    expect(stats.ordersLast30Days).toBe(1);
    expect(stats.gmvLast30DaysCents).toBe(300);
  });

  test("trend axes are continuous — 30 buckets whether or not there was activity", async () => {
    await seedOrder({ status: "PAID", totalCents: 400 });

    const stats = await invoke<PlatformStats>(platform.stats, undefined, headersFor(superA));
    expect(stats.trendDays).toBe(30);
    expect(stats.signupTrend).toHaveLength(30);
    expect(stats.ordersTrend).toHaveLength(30);

    const today = new Date().toISOString().slice(0, 10);
    expect(stats.signupTrend.at(-1)).toEqual({ date: today, tenants: 3 });
    expect(stats.ordersTrend.at(-1)).toEqual({ date: today, orders: 1, revenueCents: 400 });
    // A quiet day is a zero, not a missing point.
    expect(stats.ordersTrend[0]).toEqual({ date: stats.ordersTrend[0].date, orders: 0, revenueCents: 0 });
  });

  test("figures do NOT narrow when the admin is viewing as a tenant", async () => {
    await seedOrder({ status: "PAID", totalCents: 5_000 });
    await seedOrder({ status: "PAID", totalCents: 1_000, tenantId: TENANT_B, userId: adminB.id });

    const platformWide = await invoke<PlatformStats>(platform.stats, undefined, headersFor(superA));
    const whileViewing = await invoke<PlatformStats>(
      platform.stats,
      undefined,
      headersFor(superA, addressing("alpha")),
    );

    expect(whileViewing.ordersTotal).toBe(platformWide.ordersTotal);
    expect(whileViewing.gmvCents).toBe(platformWide.gmvCents);
    expect(whileViewing.tenantsTotal).toBe(platformWide.tenantsTotal);
    expect(whileViewing.gmvCents).toBe(6_000);
  });
});

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------

describe("platform.tenants", () => {
  test("lists every tenant with its own counts, and no one else's", async () => {
    await seedProduct(TENANT_A);
    await seedProduct(TENANT_A);
    await seedOrder({ status: "PAID", totalCents: 3_000 });
    await seedOrder({ status: "PENDING", totalCents: 500 });
    await seedLog({ action: "order.created" });

    const list = await invoke<TenantList>(platform.tenants, {}, headersFor(superA));
    expect(list.total).toBe(3);
    expect(list.tenants).toHaveLength(3);

    const bySubdomain = new Map(list.tenants.map((row) => [row.subdomain, row]));
    const alpha = bySubdomain.get("alpha")!;
    expect(alpha.userCount).toBe(2);
    expect(alpha.productCount).toBe(2);
    expect(alpha.orderCount).toBe(2);
    expect(alpha.revenueCents).toBe(3_000);
    expect(alpha.mrrCents).toBe(19_900);
    expect(alpha.lastActivityAt).not.toBeNull();

    const bravo = bySubdomain.get("bravo")!;
    expect(bravo.userCount).toBe(1);
    expect(bravo.productCount).toBe(0);
    expect(bravo.orderCount).toBe(0);
    expect(bravo.revenueCents).toBe(0);
    expect(bravo.lastActivityAt).toBeNull();
  });

  test("the status filter splits active from suspended", async () => {
    const active = await invoke<TenantList>(platform.tenants, { status: "active" }, headersFor(superA));
    expect(active.total).toBe(2);
    expect(active.tenants.map((row) => row.subdomain).sort()).toEqual(["alpha", "bravo"]);

    const suspended = await invoke<TenantList>(platform.tenants, { status: "suspended" }, headersFor(superA));
    expect(suspended.total).toBe(1);
    expect(suspended.tenants[0].subdomain).toBe("charlie");
  });

  test("the plan filter narrows to one plan", async () => {
    const starter = await invoke<TenantList>(platform.tenants, { plan: "starter" }, headersFor(superA));
    expect(starter.total).toBe(1);
    expect(starter.tenants[0].subdomain).toBe("bravo");
  });

  test("sandbox tenants can be excluded", async () => {
    const list = await invoke<TenantList>(platform.tenants, { includeSandbox: false }, headersFor(superA));
    expect(list.total).toBe(2);
    expect(list.tenants.every((row) => !row.isSandbox)).toBe(true);
  });

  test("search matches name or subdomain — a filter, not a ranking", async () => {
    const bySubdomain = await invoke<TenantList>(platform.tenants, { search: "brav" }, headersFor(superA));
    expect(bySubdomain.tenants.map((row) => row.subdomain)).toEqual(["bravo"]);

    const byName = await invoke<TenantList>(platform.tenants, { search: "Alpha Supply" }, headersFor(superA));
    expect(byName.tenants.map((row) => row.subdomain)).toEqual(["alpha"]);

    const miss = await invoke<TenantList>(platform.tenants, { search: "zzzz" }, headersFor(superA));
    expect(miss.total).toBe(0);
    expect(miss.tenants).toEqual([]);
  });

  test("paging reports the full total, not the page size", async () => {
    const first = await invoke<TenantList>(platform.tenants, { limit: 2, offset: 0 }, headersFor(superA));
    expect(first.total).toBe(3);
    expect(first.tenants).toHaveLength(2);

    const second = await invoke<TenantList>(platform.tenants, { limit: 2, offset: 2 }, headersFor(superA));
    expect(second.total).toBe(3);
    expect(second.tenants).toHaveLength(1);

    const ids = new Set([...first.tenants, ...second.tenants].map((row) => row.id));
    expect(ids.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// tenantDetail
// ---------------------------------------------------------------------------

describe("platform.tenantDetail", () => {
  test("returns one tenant in full, with nothing from the tenant next door", async () => {
    await seedProduct(TENANT_A);
    await seedOrder({ status: "PAID", totalCents: 4_000 });
    await seedOrder({ status: "PAID", totalCents: 1_000 });
    await seedOrder({ status: "PENDING", totalCents: 750 });
    await seedLog({ action: "order.created" });
    await moduleDb.insert(featureFlags).values({ tenantId: TENANT_A, key: "quotes", enabled: true });

    await seedProduct(TENANT_B);
    await seedOrder({ status: "PAID", totalCents: 90_000, tenantId: TENANT_B, userId: adminB.id });
    await seedLog({ action: "order.created", tenantId: TENANT_B, userId: adminB.id });

    const detail = await invoke<TenantDetail>(
      platform.tenantDetail,
      { tenantId: TENANT_A },
      headersFor(superA),
    );

    expect(detail.id).toBe(TENANT_A);
    expect(detail.name).toBe("Alpha Supply Co");
    expect(detail.plan).toBe("professional");
    expect(detail.mrrCents).toBe(19_900);
    expect(detail.squareConnected).toBe(false);
    expect(detail.billingConnected).toBe(false);

    expect(detail.productCount).toBe(1);
    expect(detail.orderCount).toBe(3);
    expect(detail.revenueCents).toBe(5_000);
    expect(detail.openOrderValueCents).toBe(750);

    const byStatus = new Map(detail.ordersByStatus.map((row) => [row.status, row]));
    expect(byStatus.get("PAID")).toEqual({ status: "PAID", orders: 2, totalCents: 5_000 });
    expect(byStatus.get("PENDING")).toEqual({ status: "PENDING", orders: 1, totalCents: 750 });

    expect(detail.userCount).toBe(2);
    expect(detail.users.map((user) => user.email).sort()).toEqual([
      "admin-a@example.com",
      "staff-a@example.com",
    ]);

    expect(detail.recentOrders).toHaveLength(3);
    expect(detail.featureFlags.map((flag) => flag.key)).toEqual(["quotes"]);

    expect(detail.recentActivity).toHaveLength(1);
    // The mothership resolves actors platform-wide — the old console rendered raw user ids.
    expect(detail.recentActivity[0].userEmail).toBe("admin-a@example.com");
  });

  test("an unknown tenant is a 404, not an empty shell", async () => {
    await expectRejection(
      invoke(platform.tenantDetail, { tenantId: "tenant_nope" }, headersFor(superA)),
      "NOT_FOUND",
      /Tenant not found/,
    );
  });

  test("a suspended tenant is still inspectable", async () => {
    const detail = await invoke<TenantDetail>(
      platform.tenantDetail,
      { tenantId: TENANT_C },
      headersFor(superA),
    );
    expect(detail.isActive).toBe(false);
    expect(detail.mrrCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

describe("platform.activity", () => {
  test("spans every tenant, naming the tenant and the actor", async () => {
    await seedLog({ action: "order.created" });
    await seedLog({ action: "product.updated", tenantId: TENANT_B, userId: adminB.id, entity: "product" });

    const feed = await invoke<PlatformFeed>(platform.activity, {}, headersFor(superA));
    expect(feed.total).toBe(2);

    const byTenant = new Map(feed.entries.map((entry) => [entry.tenantId, entry]));
    expect(byTenant.get(TENANT_A)!.tenantName).toBe("Alpha Supply Co");
    expect(byTenant.get(TENANT_A)!.tenantSubdomain).toBe("alpha");
    expect(byTenant.get(TENANT_A)!.userEmail).toBe("admin-a@example.com");
    expect(byTenant.get(TENANT_B)!.tenantName).toBe("Bravo Wholesale");
    expect(byTenant.get(TENANT_B)!.userEmail).toBe("admin-b@example.com");
  });

  test("the tenant filter narrows the feed", async () => {
    await seedLog({ action: "order.created" });
    await seedLog({ action: "order.created", tenantId: TENANT_B, userId: adminB.id });

    const feed = await invoke<PlatformFeed>(platform.activity, { tenantId: TENANT_B }, headersFor(superA));
    expect(feed.total).toBe(1);
    expect(feed.entries[0].tenantId).toBe(TENANT_B);
  });

  test("entity and search filters narrow further", async () => {
    await seedLog({ action: "order.created", entity: "order" });
    await seedLog({ action: "product.updated", entity: "product" });

    const byEntity = await invoke<PlatformFeed>(platform.activity, { entity: "product" }, headersFor(superA));
    expect(byEntity.total).toBe(1);
    expect(byEntity.entries[0].action).toBe("product.updated");

    const bySearch = await invoke<PlatformFeed>(platform.activity, { search: "order." }, headersFor(superA));
    expect(bySearch.total).toBe(1);
    expect(bySearch.entries[0].action).toBe("order.created");
  });

  test("a log row with no actor resolves to null rather than failing", async () => {
    await seedLog({ action: "system.backfill", userId: null });
    const feed = await invoke<PlatformFeed>(platform.activity, {}, headersFor(superA));
    expect(feed.entries[0].userId).toBeNull();
    expect(feed.entries[0].userEmail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setTenantActive
// ---------------------------------------------------------------------------

describe("platform.setTenantActive", () => {
  test("suspends a tenant and records it in that tenant's own audit trail", async () => {
    const result = await invoke<MutationResult>(
      platform.setTenantActive,
      { tenantId: TENANT_A, isActive: false, reason: "chargeback investigation" },
      headersFor(superA),
    );
    expect(result.changed).toBe(true);
    expect(result.isActive).toBe(false);

    const [tenant] = await moduleDb.select().from(tenants).where(eq(tenants.id, TENANT_A));
    expect(tenant.isActive).toBe(false);

    const logs = await moduleDb.select().from(activityLogs).where(eq(activityLogs.tenantId, TENANT_A));
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("tenant.suspended");
    expect(logs[0].entity).toBe("tenant");
    expect(logs[0].entityId).toBe(TENANT_A);
    expect(logs[0].details).toEqual({
      previous: true,
      next: false,
      reason: "chargeback investigation",
      by: "platform support",
    });

    // Nothing landed in anyone else's trail.
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_B))).toBe(0);
  });

  test("a no-op writes nothing", async () => {
    const result = await invoke<MutationResult>(
      platform.setTenantActive,
      { tenantId: TENANT_A, isActive: true },
      headersFor(superA),
    );
    expect(result.changed).toBe(false);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_A))).toBe(0);
  });

  test("reactivating logs the other way round", async () => {
    const result = await invoke<MutationResult>(
      platform.setTenantActive,
      { tenantId: TENANT_C, isActive: true },
      headersFor(superA),
    );
    expect(result.changed).toBe(true);
    expect(result.isActive).toBe(true);

    const logs = await moduleDb.select().from(activityLogs).where(eq(activityLogs.tenantId, TENANT_C));
    expect(logs[0].action).toBe("tenant.reactivated");
  });

  test("suspension actually locks the tenant out — end to end", async () => {
    // Before: a normal working day.
    const before = await invoke<SessionCurrent>(session.current, undefined, headersFor(adminA));
    expect(before.tenant!.id).toBe(TENANT_A);

    await invoke(platform.setTenantActive, { tenantId: TENANT_A, isActive: false }, headersFor(superA));

    // After: every request from inside that tenant is refused by the middleware.
    await expectRejection(invoke(session.current, undefined, headersFor(adminA)), "FORBIDDEN");
    await expectRejection(invoke(activity.actions, undefined, headersFor(staffA)), "FORBIDDEN");

    // The tenant next door is untouched.
    const neighbour = await invoke<SessionCurrent>(session.current, undefined, headersFor(adminB));
    expect(neighbour.tenant!.id).toBe(TENANT_B);

    // And platform support can still get in to fix it.
    const support = await invoke<SessionCurrent>(
      session.current,
      undefined,
      headersFor(superA, addressing("alpha")),
    );
    expect(support.tenant!.id).toBe(TENANT_A);
    expect(support.isViewingAsTenant).toBe(true);
  });

  test("an unknown tenant is a 404", async () => {
    await expectRejection(
      invoke(platform.setTenantActive, { tenantId: "tenant_nope", isActive: false }, headersFor(superA)),
      "NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// updateTenantPlan
// ---------------------------------------------------------------------------

describe("platform.updateTenantPlan", () => {
  test("moves a plan and records the commercial effect", async () => {
    const result = await invoke<MutationResult>(
      platform.updateTenantPlan,
      { tenantId: TENANT_B, plan: "enterprise" },
      headersFor(superA),
    );
    expect(result.changed).toBe(true);
    expect(result.plan).toBe("enterprise");

    const logs = await moduleDb.select().from(activityLogs).where(eq(activityLogs.tenantId, TENANT_B));
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("tenant.plan_changed");
    expect(logs[0].details).toEqual({
      previous: "starter",
      next: "enterprise",
      mrrDeltaCents: 95_000,
      by: "platform support",
    });
  });

  test("a suspended tenant's plan change is worth nothing until it is back on", async () => {
    await invoke(platform.updateTenantPlan, { tenantId: TENANT_C, plan: "starter" }, headersFor(superA));
    const logs = await moduleDb.select().from(activityLogs).where(eq(activityLogs.tenantId, TENANT_C));
    expect((logs[0].details as { mrrDeltaCents: number }).mrrDeltaCents).toBe(0);
  });

  test("a no-op writes nothing", async () => {
    const result = await invoke<MutationResult>(
      platform.updateTenantPlan,
      { tenantId: TENANT_B, plan: "starter" },
      headersFor(superA),
    );
    expect(result.changed).toBe(false);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_B))).toBe(0);
  });

  test("an unknown plan is rejected before anything is written", async () => {
    await expectRejection(
      invoke(platform.updateTenantPlan, { tenantId: TENANT_B, plan: "platinum" }, headersFor(superA)),
      "BAD_REQUEST",
    );
  });
});

// ---------------------------------------------------------------------------
// activity.logTenantEntry — the audit half of "open as tenant"
// ---------------------------------------------------------------------------

describe("activity.logTenantEntry", () => {
  test("records platform support opening the workspace, in the tenant's own trail", async () => {
    const result = await invoke<{ logged: boolean }>(
      activity.logTenantEntry,
      undefined,
      headersFor(superA, addressing("alpha")),
    );
    expect(result.logged).toBe(true);

    const logs = await moduleDb.select().from(activityLogs).where(eq(activityLogs.tenantId, TENANT_A));
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("tenant.viewed");
    expect(logs[0].entity).toBe("tenant");
    expect(logs[0].entityId).toBe(TENANT_A);
    expect(logs[0].userId).toBe(superA.id);
    // A label, not a name: the customer sees who is looking is "the platform", not an id.
    expect(logs[0].details).toEqual({ by: "platform support" });
  });

  test("a second visit inside the dedupe window writes nothing", async () => {
    await invoke(activity.logTenantEntry, undefined, headersFor(superA, addressing("alpha")));
    const second = await invoke<{ logged: boolean }>(
      activity.logTenantEntry,
      undefined,
      headersFor(superA, addressing("alpha")),
    );
    expect(second.logged).toBe(false);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_A))).toBe(1);
  });

  test("a visit after the window is a new entry", async () => {
    await moduleDb.insert(activityLogs).values({
      tenantId: TENANT_A,
      userId: superA.id,
      action: "tenant.viewed",
      entity: "tenant",
      entityId: TENANT_A,
      createdAt: new Date(Date.now() - 31 * 60 * 1000),
    });

    const result = await invoke<{ logged: boolean }>(
      activity.logTenantEntry,
      undefined,
      headersFor(superA, addressing("alpha")),
    );
    expect(result.logged).toBe(true);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_A))).toBe(2);
  });

  test("each tenant gets its own entry", async () => {
    await invoke(activity.logTenantEntry, undefined, headersFor(superA, addressing("alpha")));
    await invoke(activity.logTenantEntry, undefined, headersFor(superA, addressing("bravo")));

    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_A))).toBe(1);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_B))).toBe(1);
  });

  test("a real tenant admin working in their own workspace is not an event", async () => {
    const result = await invoke<{ logged: boolean }>(activity.logTenantEntry, undefined, headersFor(adminA));
    expect(result.logged).toBe(false);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_A))).toBe(0);
  });

  test("a super admin who has not opened a tenant logs nothing", async () => {
    const result = await invoke<{ logged: boolean }>(activity.logTenantEntry, undefined, headersFor(superA));
    expect(result.logged).toBe(false);
    expect((await moduleDb.select().from(activityLogs)).length).toBe(0);
  });

  test("the customer sees the visit, without the platform admin's identity", async () => {
    await invoke(activity.logTenantEntry, undefined, headersFor(superA, addressing("alpha")));

    const feed = await invoke<TenantFeed>(activity.list, {}, headersFor(staffA));
    expect(feed.total).toBe(1);
    expect(feed.entries[0].action).toBe("tenant.viewed");
    expect(feed.entries[0].details).toEqual({ by: "platform support" });
    // The super admin's user row is outside this tenant, so their email does not resolve here.
    expect(feed.entries[0].userEmail).toBeNull();

    // The platform's own view of the same row does name them.
    const platformFeed = await invoke<PlatformFeed>(platform.activity, {}, headersFor(superA));
    expect(platformFeed.entries[0].userEmail).toBe("platform@example.com");
  });

  test("a buyer cannot reach it at all", async () => {
    const clientA = await signUp("client-a@example.com", TENANT_A, "TENANT_CLIENT");
    await expectRejection(invoke(activity.logTenantEntry, undefined, headersFor(clientA)), "FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// session.current — what the shell's banner is driven from
// ---------------------------------------------------------------------------

describe("session.current — viewing as a tenant", () => {
  test("a super admin addressing a tenant is flagged, with the tenant named", async () => {
    const result = await invoke<SessionCurrent>(
      session.current,
      undefined,
      headersFor(superA, addressing("alpha")),
    );
    expect(result.isViewingAsTenant).toBe(true);
    expect(result.viewingTenant).toEqual({
      id: TENANT_A,
      name: "Alpha Supply Co",
      subdomain: "alpha",
    });
    // The role does not drop — the flag is derived from it, not instead of it.
    expect(result.user!.role).toBe("SUPER_ADMIN");
  });

  test("a super admin on the mothership is not viewing anything", async () => {
    const result = await invoke<SessionCurrent>(session.current, undefined, headersFor(superA));
    expect(result.tenant).toBeNull();
    expect(result.isViewingAsTenant).toBe(false);
    expect(result.viewingTenant).toBeNull();
  });

  test("a tenant admin in their own workspace is never flagged", async () => {
    const result = await invoke<SessionCurrent>(session.current, undefined, headersFor(adminA));
    expect(result.tenant!.id).toBe(TENANT_A);
    expect(result.isViewingAsTenant).toBe(false);
    expect(result.viewingTenant).toBeNull();
  });

  test("a tenant admin addressing someone else's tenant is refused, not flagged", async () => {
    await expectRejection(
      invoke(session.current, undefined, headersFor(adminA, addressing("bravo"))),
      "FORBIDDEN",
    );
  });

  test("switching tenants switches the banner", async () => {
    const onBravo = await invoke<SessionCurrent>(
      session.current,
      undefined,
      headersFor(superA, addressing("bravo")),
    );
    expect(onBravo.viewingTenant!.subdomain).toBe("bravo");
    // No stored impersonation state, so nothing to carry over or get stuck in.
    const back = await invoke<SessionCurrent>(session.current, undefined, headersFor(superA));
    expect(back.viewingTenant).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteTenantCascade — the one destructive operation
// ---------------------------------------------------------------------------

describe("deleteTenantCascade", () => {
  test("removes every row belonging to the tenant, and only that tenant", async () => {
    await seedFullTenant(TENANT_A, adminA.id);
    await seedFullTenant(TENANT_B, adminB.id);

    const result = await deleteTenantCascade(superA.ctx, TENANT_A);

    expect(result.tenantId).toBe(TENANT_A);
    expect(result.deleted.orderLineItems).toBe(1);
    expect(result.deleted.payments).toBe(1);
    expect(result.deleted.orders).toBe(1);
    expect(result.deleted.cartItems).toBe(1);
    expect(result.deleted.carts).toBe(1);
    expect(result.deleted.inventoryEvents).toBe(1);
    expect(result.deleted.priceTiers).toBe(1);
    expect(result.deleted.products).toBe(1);
    expect(result.deleted.categories).toBe(1);
    expect(result.deleted.companies).toBe(1);
    expect(result.deleted.shippingRates).toBe(1);
    expect(result.deleted.activityLogs).toBe(1);
    expect(result.deleted.featureFlags).toBe(1);
    expect(result.deleted.users).toBe(2); // adminA + staffA
    expect(result.deleted.tenants).toBe(1);
    expect(result.total).toBe(Object.values(result.deleted).reduce((sum, n) => sum + n, 0));

    // Gone.
    expect(await rowCount(tenants, eq(tenants.id, TENANT_A))).toBe(0);
    expect(await rowCount(users, eq(users.tenantId, TENANT_A))).toBe(0);
    expect(await rowCount(products, eq(products.tenantId, TENANT_A))).toBe(0);
    expect(await rowCount(ordersTable, eq(ordersTable.tenantId, TENANT_A))).toBe(0);
    expect(await rowCount(activityLogs, eq(activityLogs.tenantId, TENANT_A))).toBe(0);

    // The tenant next door is completely intact.
    expect(await rowCount(tenants, eq(tenants.id, TENANT_B))).toBe(1);
    expect(await rowCount(users, eq(users.tenantId, TENANT_B))).toBe(1);
    expect(await rowCount(products, eq(products.tenantId, TENANT_B))).toBe(1);
    expect(await rowCount(ordersTable, eq(ordersTable.tenantId, TENANT_B))).toBe(1);
    expect(await rowCount(payments, eq(payments.tenantId, TENANT_B))).toBe(1);
    expect(await rowCount(featureFlags, eq(featureFlags.tenantId, TENANT_B))).toBe(1);
    // Line items have no tenantId of their own — the survivor proves they were reached via order.
    expect((await moduleDb.select().from(orderLineItems)).length).toBe(1);

    // And the platform's own numbers move with it.
    const stats = await invoke<PlatformStats>(platform.stats, undefined, headersFor(superA));
    expect(stats.tenantsTotal).toBe(2);
  });

  test("the super admin's own row survives — they are not in the tenant", async () => {
    await seedFullTenant(TENANT_A, adminA.id);
    await deleteTenantCascade(superA.ctx, TENANT_A);
    expect(await rowCount(users, eq(users.id, superA.id))).toBe(1);
  });

  test("a tenant admin cannot delete their own tenant", async () => {
    await seedFullTenant(TENANT_A, adminA.id);
    await expectScopeError(
      deleteTenantCascade(adminA.ctx, TENANT_A),
      /Only a platform super admin may delete a tenant/,
    );
    expect(await rowCount(tenants, eq(tenants.id, TENANT_A))).toBe(1);
    expect(await rowCount(products, eq(products.tenantId, TENANT_A))).toBe(1);
  });

  test("a tenant admin cannot delete someone else's tenant either", async () => {
    await seedFullTenant(TENANT_B, adminB.id);
    await expectScopeError(deleteTenantCascade(adminA.ctx, TENANT_B), /super admin/);
    expect(await rowCount(tenants, eq(tenants.id, TENANT_B))).toBe(1);
  });

  test("an empty tenantId is refused rather than treated as a wildcard", async () => {
    await seedFullTenant(TENANT_A, adminA.id);
    await expectScopeError(deleteTenantCascade(superA.ctx, "   "), /requires a tenantId/);
    expect(await rowCount(tenants, eq(tenants.id, TENANT_A))).toBe(1);
  });

  test("an unknown tenant deletes nothing and reports nothing", async () => {
    await seedFullTenant(TENANT_A, adminA.id);
    const result = await deleteTenantCascade(superA.ctx, "tenant_nope");
    expect(result.total).toBe(0);
    expect(await rowCount(tenants, eq(tenants.id, TENANT_A))).toBe(1);
  });
});
