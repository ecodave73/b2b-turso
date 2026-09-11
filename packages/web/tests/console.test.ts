/**
 * Phase 4 back-office API — dashboard aggregates, activity log, tenant settings.
 *
 * Same unmocked shape as middleware-auth.test.ts and services.test.ts: real Better Auth
 * sessions, real `call()` through the real middleware chain, real scoped database, fixtures
 * written with the RAW module client so the guard is never the thing that seeded the data.
 *
 * These three routers exist only because four phase-4 pages had no API behind them. They are
 * read-mostly and aggregate across a tenant's whole dataset, which makes them exactly the
 * shape where a missing tenant filter would leak — hence a cross-tenant probe on every one.
 *
 * Money in CENTS, tax in BASIS POINTS. A float in an expected value is a bug in the test.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { call, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import {
  activityLogs,
  inventoryEvents,
  orderLineItems,
  orders as ordersTable,
  products,
  tenants,
  users,
} from "../src/api/database/schema";
import { activity } from "../src/api/routes/activity";
import { dashboard } from "../src/api/routes/dashboard";
import { settings } from "../src/api/routes/settings";
import type { OrderStatus } from "../src/api/services/orders";
import type { RequestContext, Role } from "../src/api/tenant/context";
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

/** `any` is deliberate — these procedures sit on different bases with different input shapes. */
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
// Fixtures
// ---------------------------------------------------------------------------

let adminA: Caller;
let staffA: Caller;
let clientA: Caller;
let adminB: Caller;

let seq = 0;

async function seedProduct(options: {
  tenantId?: string;
  moq?: number;
  isActive?: boolean;
  name?: string;
} = {}) {
  seq += 1;
  const row = {
    id: `product_${seq}`,
    tenantId: options.tenantId ?? TENANT_A,
    sku: `SKU-${seq}`,
    name: options.name ?? `Product ${seq}`,
    unitPriceCents: 1000,
    taxRateBp: 1000,
    moq: options.moq ?? 1,
    isActive: options.isActive ?? true,
    images: [] as string[],
  };
  await moduleDb.insert(products).values(row);
  return row;
}

async function seedStock(productId: string, quantity: number, tenantId = TENANT_A, createdBy = staffA.id) {
  await moduleDb
    .insert(inventoryEvents)
    .values({ tenantId, productId, eventType: "RECEIVED", quantity, createdBy });
}

async function seedOrder(options: {
  status: OrderStatus;
  totalCents?: number;
  tenantId?: string;
  createdAt?: Date;
  userId?: string;
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
  entityId?: string | null;
  createdAt?: Date;
}) {
  const [row] = await moduleDb
    .insert(activityLogs)
    .values({
      tenantId: options.tenantId ?? TENANT_A,
      userId: options.userId === undefined ? adminA.id : options.userId,
      action: options.action,
      entity: options.entity ?? "order",
      entityId: options.entityId ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning();
  return row;
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
  ]);
  adminA = await signUp("admin-a@example.com", TENANT_A, "TENANT_ADMIN");
  staffA = await signUp("staff-a@example.com", TENANT_A, "TENANT_STAFF");
  clientA = await signUp("client-a@example.com", TENANT_A, "TENANT_CLIENT");
  adminB = await signUp("admin-b@example.com", TENANT_B, "TENANT_ADMIN");
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

interface Stats {
  products: { total: number; active: number; lowStock: number };
  orders: { total: number; open: number; byStatus: Record<OrderStatus, number> };
  revenueCents: number;
  openValueCents: number;
  recentOrders: { id: string; orderNumber: string; status: string; totalCents: number; itemCount: number }[];
}

describe("dashboard.stats", () => {
  test("counts products and splits orders by status", async () => {
    await seedProduct({});
    await seedProduct({ isActive: false });
    await seedOrder({ status: "PENDING" });
    await seedOrder({ status: "PAID" });
    await seedOrder({ status: "CANCELLED" });

    const stats = await invoke<Stats>(dashboard.stats, undefined, staffA);
    expect(stats.products.total).toBe(2);
    expect(stats.products.active).toBe(1);
    expect(stats.orders.total).toBe(3);
    expect(stats.orders.byStatus.PENDING).toBe(1);
    expect(stats.orders.byStatus.PAID).toBe(1);
    expect(stats.orders.byStatus.CANCELLED).toBe(1);
    expect(stats.orders.byStatus.DRAFT).toBe(0);
  });

  test("revenue counts only PAID and CLOSED; open value counts the pipeline", async () => {
    await seedOrder({ status: "PAID", totalCents: 5000 });
    await seedOrder({ status: "CLOSED", totalCents: 2500 });
    await seedOrder({ status: "PENDING", totalCents: 900 });
    await seedOrder({ status: "CONFIRMED", totalCents: 100 });
    await seedOrder({ status: "CANCELLED", totalCents: 99_999 });

    const stats = await invoke<Stats>(dashboard.stats, undefined, staffA);
    expect(stats.revenueCents).toBe(7500);
    expect(stats.openValueCents).toBe(1000);
    expect(stats.orders.open).toBe(2);
  });

  test("low stock is an active product whose derived stock is under its MOQ", async () => {
    const thin = await seedProduct({ moq: 10 });
    await seedStock(thin.id, 4);
    const healthy = await seedProduct({ moq: 10 });
    await seedStock(healthy.id, 40);
    const archived = await seedProduct({ moq: 10, isActive: false });
    await seedStock(archived.id, 0);

    const stats = await invoke<Stats>(dashboard.stats, undefined, staffA);
    expect(stats.products.lowStock).toBe(1);

    const rows = await invoke<{ id: string; stockOnHand: number; moq: number }[]>(
      dashboard.lowStock,
      undefined,
      staffA,
    );
    expect(rows.map((row) => row.id)).toEqual([thin.id]);
    expect(rows[0].stockOnHand).toBe(4);
  });

  test("recent orders are newest first and carry a line count", async () => {
    const product = await seedProduct({});
    const older = await seedOrder({ status: "PENDING", createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = await seedOrder({ status: "PENDING", createdAt: new Date("2026-06-01T00:00:00Z") });
    await moduleDb.insert(orderLineItems).values([
      { orderId: newer.id, productId: product.id, quantity: 2, unitPriceCents: 1000, totalPriceCents: 2000 },
      { orderId: newer.id, productId: product.id, quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000 },
    ]);

    const stats = await invoke<Stats>(dashboard.stats, undefined, staffA);
    expect(stats.recentOrders.map((order) => order.id)).toEqual([newer.id, older.id]);
    expect(stats.recentOrders[0].itemCount).toBe(2);
    expect(stats.recentOrders[1].itemCount).toBe(0);
  });

  test("CROSS-TENANT: another tenant's products, orders and revenue are invisible", async () => {
    await seedProduct({ tenantId: TENANT_B });
    await seedOrder({ status: "PAID", totalCents: 999_999, tenantId: TENANT_B, userId: adminB.id });
    await seedProduct({});

    const stats = await invoke<Stats>(dashboard.stats, undefined, adminA);
    expect(stats.products.total).toBe(1);
    expect(stats.orders.total).toBe(0);
    expect(stats.revenueCents).toBe(0);
    expect(stats.recentOrders).toHaveLength(0);
  });

  test("a client cannot read back-office aggregates", async () => {
    await expectRejection(invoke(dashboard.stats, undefined, clientA), "FORBIDDEN");
    await expectRejection(invoke(dashboard.lowStock, undefined, clientA), "FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

interface ActivityPage {
  total: number;
  limit: number;
  offset: number;
  entries: {
    id: string;
    action: string;
    entity: string;
    entityId: string | null;
    userId: string | null;
    userEmail: string | null;
  }[];
}

describe("activity", () => {
  test("lists newest first with a total and honours paging", async () => {
    await seedLog({ action: "order.created", createdAt: new Date("2026-01-01T00:00:00Z") });
    await seedLog({ action: "order.status_changed", createdAt: new Date("2026-02-01T00:00:00Z") });
    await seedLog({ action: "product.archived", createdAt: new Date("2026-03-01T00:00:00Z") });

    const first = await invoke<ActivityPage>(activity.list, { limit: 2 }, staffA);
    expect(first.total).toBe(3);
    expect(first.entries.map((entry) => entry.action)).toEqual(["product.archived", "order.status_changed"]);

    const second = await invoke<ActivityPage>(activity.list, { limit: 2, offset: 2 }, staffA);
    expect(second.entries.map((entry) => entry.action)).toEqual(["order.created"]);
  });

  test("filters by action and resolves the actor's email", async () => {
    await seedLog({ action: "order.created", userId: adminA.id });
    await seedLog({ action: "product.archived", userId: staffA.id });

    const page = await invoke<ActivityPage>(activity.list, { action: "product.archived" }, staffA);
    expect(page.total).toBe(1);
    expect(page.entries[0].userEmail).toBe("staff-a@example.com");
  });

  test("an actor outside the tenant resolves to null instead of leaking a name", async () => {
    await seedLog({ action: "order.created", userId: adminB.id });
    const page = await invoke<ActivityPage>(activity.list, undefined, staffA);
    expect(page.entries[0].userId).toBe(adminB.id);
    expect(page.entries[0].userEmail).toBeNull();
  });

  test("distinct actions are the tenant's own, sorted", async () => {
    await seedLog({ action: "product.archived" });
    await seedLog({ action: "order.created" });
    await seedLog({ action: "order.created" });
    await seedLog({ action: "tenant.settings_updated", tenantId: TENANT_B, userId: adminB.id });

    const actions = await invoke<string[]>(activity.actions, undefined, staffA);
    expect(actions).toEqual(["order.created", "product.archived"]);
  });

  test("CROSS-TENANT: another tenant's audit trail is invisible", async () => {
    await seedLog({ action: "order.created", tenantId: TENANT_B, userId: adminB.id });
    const page = await invoke<ActivityPage>(activity.list, undefined, adminA);
    expect(page.total).toBe(0);
    expect(page.entries).toHaveLength(0);
  });

  test("a client cannot read the audit trail", async () => {
    await expectRejection(invoke(activity.list, undefined, clientA), "FORBIDDEN");
    await expectRejection(invoke(activity.actions, undefined, clientA), "FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface TenantSettings {
  id: string;
  name: string;
  brandColor: string;
  logo: string | null;
  subdomain: string;
  plan: string;
  isActive: boolean;
  billingConnected: boolean;
}

describe("settings", () => {
  test("staff read their own tenant's profile", async () => {
    const profile = await invoke<TenantSettings>(settings.get, undefined, staffA);
    expect(profile.id).toBe(TENANT_A);
    expect(profile.name).toBe("Alpha Supply Co");
    expect(profile.subdomain).toBe("alpha");
    expect(profile.plan).toBe("professional");
    expect(profile.billingConnected).toBe(false);
  });

  test("an admin updates branding and the change is logged", async () => {
    const updated = await invoke<{ name: string; brandColor: string }>(
      settings.update,
      { name: "Alpha Supply", brandColor: "#2260F6" },
      adminA,
    );
    expect(updated.name).toBe("Alpha Supply");
    expect(updated.brandColor).toBe("#2260F6");

    const row = await moduleDb.select().from(tenants).where(eq(tenants.id, TENANT_A));
    expect(row[0].name).toBe("Alpha Supply");

    const logs = await moduleDb.select().from(activityLogs).where(eq(activityLogs.tenantId, TENANT_A));
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("tenant.settings_updated");
  });

  test("staff may read but not write", async () => {
    await expectRejection(invoke(settings.update, { name: "Hijack" }, staffA), "FORBIDDEN");
  });

  test("a client cannot read tenant settings at all", async () => {
    await expectRejection(invoke(settings.get, undefined, clientA), "FORBIDDEN");
  });

  test("a malformed brand colour is refused", async () => {
    await expectRejection(invoke(settings.update, { brandColor: "blue" }, adminA), "BAD_REQUEST");
  });

  test("plan, isActive and subdomain are not self-service", async () => {
    // Unknown keys are stripped, which leaves nothing to update — the refine rejects it rather
    // than silently reporting success on a write that never happened.
    await expectRejection(
      invoke(settings.update, { plan: "enterprise", isActive: false, subdomain: "hijack" }, adminA),
      "BAD_REQUEST",
    );

    const row = await moduleDb.select().from(tenants).where(eq(tenants.id, TENANT_A));
    expect(row[0].plan).toBe("professional");
    expect(row[0].isActive).toBe(true);
    expect(row[0].subdomain).toBe("alpha");
  });

  test("CROSS-TENANT: an admin's update lands on their own tenant only", async () => {
    await invoke(settings.update, { name: "Bravo Renamed" }, adminB);

    const rows = await moduleDb.select().from(tenants);
    const alpha = rows.find((row) => row.id === TENANT_A);
    const bravo = rows.find((row) => row.id === TENANT_B);
    expect(alpha?.name).toBe("Alpha Supply Co");
    expect(bravo?.name).toBe("Bravo Renamed");
  });
});
