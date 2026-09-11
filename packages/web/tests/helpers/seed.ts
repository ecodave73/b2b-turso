import type { RequestContext } from "../../src/api/tenant/context";
import {
  activityLogs,
  cartItems,
  carts,
  categories,
  companies,
  featureFlags,
  inventoryEvents,
  orderLineItems,
  orders,
  payments,
  priceTiers,
  products,
  shippingRates,
  tenants,
  users,
} from "../../src/api/database/schema";
import type { TestDb } from "./db";

/**
 * Two fully-populated tenants, written with the RAW client on purpose — fixtures must be able
 * to straddle tenants so the guard has something to isolate. Application code may never do this.
 */

export const TENANT_A = "tenant_a";
export const TENANT_B = "tenant_b";

export interface Seed {
  productA: string;
  productB: string;
  orderA: string;
  orderB: string;
  lineItemA: string;
  lineItemB: string;
  cartA: string;
  cartB: string;
}

export const ctxA: RequestContext = { userId: "user_a_admin", tenantId: TENANT_A, role: "TENANT_ADMIN" };
export const ctxAStaff: RequestContext = { userId: "user_a_staff", tenantId: TENANT_A, role: "TENANT_STAFF" };
export const ctxB: RequestContext = { userId: "user_b_admin", tenantId: TENANT_B, role: "TENANT_ADMIN" };
export const ctxSuper: RequestContext = { userId: "user_super", tenantId: null, role: "SUPER_ADMIN" };
export const ctxAnon: RequestContext = { userId: null, tenantId: null, role: "TENANT_CLIENT" };
/** Signed in, but the host has not resolved to a tenant yet. */
export const ctxUnresolved: RequestContext = { userId: "user_unassigned", tenantId: null, role: "TENANT_CLIENT" };

export async function seed(db: TestDb): Promise<Seed> {
  await db.insert(tenants).values([
    { id: TENANT_A, subdomain: "alpha", name: "Alpha Supply Co", plan: "professional" },
    { id: TENANT_B, subdomain: "bravo", name: "Bravo Wholesale", plan: "starter" },
  ]);

  await db.insert(users).values([
    { id: "user_a_admin", email: "admin@alpha.test", name: "Alpha Admin", tenantId: TENANT_A, role: "TENANT_ADMIN" },
    { id: "user_a_staff", email: "staff@alpha.test", name: "Alpha Staff", tenantId: TENANT_A, role: "TENANT_STAFF" },
    { id: "user_b_admin", email: "admin@bravo.test", name: "Bravo Admin", tenantId: TENANT_B, role: "TENANT_ADMIN" },
    { id: "user_super", email: "root@platform.test", name: "Platform Root", tenantId: null, role: "SUPER_ADMIN" },
    { id: "user_unassigned", email: "new@nowhere.test", name: "Unassigned", tenantId: null, role: "TENANT_CLIENT" },
  ]);

  await db.insert(companies).values([
    { id: "co_a", tenantId: TENANT_A, name: "Alpha Client Pty Ltd", abn: "11111111111" },
    { id: "co_b", tenantId: TENANT_B, name: "Bravo Client Pty Ltd", abn: "22222222222" },
  ]);

  await db.insert(categories).values([
    { id: "cat_a", tenantId: TENANT_A, name: "Fasteners", slug: "fasteners" },
    { id: "cat_b", tenantId: TENANT_B, name: "Adhesives", slug: "adhesives" },
  ]);

  await db.insert(products).values([
    {
      id: "prod_a",
      tenantId: TENANT_A,
      categoryId: "cat_a",
      sku: "A-001",
      name: "M8 Bolt",
      unitPriceCents: 1250,
      taxRateBp: 1000,
      moq: 10,
      weightGrams: 40,
    },
    {
      id: "prod_b",
      tenantId: TENANT_B,
      categoryId: "cat_b",
      sku: "B-001",
      name: "Epoxy 500ml",
      unitPriceCents: 4995,
      taxRateBp: 1000,
      moq: 1,
      weightGrams: 620,
    },
  ]);

  await db.insert(priceTiers).values([
    { id: "tier_a", tenantId: TENANT_A, productId: "prod_a", minQty: 100, unitPriceCents: 1100 },
    { id: "tier_b", tenantId: TENANT_B, productId: "prod_b", minQty: 12, unitPriceCents: 4500 },
  ]);

  await db.insert(inventoryEvents).values([
    {
      id: "inv_a",
      tenantId: TENANT_A,
      productId: "prod_a",
      eventType: "RECEIVED",
      quantity: 500,
      createdBy: "user_a_admin",
    },
    {
      id: "inv_b",
      tenantId: TENANT_B,
      productId: "prod_b",
      eventType: "RECEIVED",
      quantity: 80,
      createdBy: "user_b_admin",
    },
  ]);

  await db.insert(orders).values([
    {
      id: "ord_a",
      tenantId: TENANT_A,
      orderNumber: "ALPHA-1001",
      companyId: "co_a",
      userId: "user_a_admin",
      status: "CONFIRMED",
      subtotalCents: 12500,
      taxTotalCents: 1250,
      totalCents: 13750,
    },
    {
      id: "ord_b",
      tenantId: TENANT_B,
      orderNumber: "BRAVO-2001",
      companyId: "co_b",
      userId: "user_b_admin",
      status: "PENDING",
      subtotalCents: 49950,
      taxTotalCents: 4995,
      totalCents: 54945,
    },
  ]);

  await db.insert(orderLineItems).values([
    { id: "li_a", orderId: "ord_a", productId: "prod_a", quantity: 10, unitPriceCents: 1250, totalPriceCents: 12500 },
    { id: "li_b", orderId: "ord_b", productId: "prod_b", quantity: 10, unitPriceCents: 4995, totalPriceCents: 49950 },
  ]);

  await db.insert(carts).values([
    { id: "cart_a", tenantId: TENANT_A, userId: "user_a_admin" },
    { id: "cart_b", tenantId: TENANT_B, userId: "user_b_admin" },
  ]);

  await db.insert(cartItems).values([
    { id: "ci_a", cartId: "cart_a", tenantId: TENANT_A, productId: "prod_a", quantity: 5, priceCents: 1250 },
    { id: "ci_b", cartId: "cart_b", tenantId: TENANT_B, productId: "prod_b", quantity: 2, priceCents: 4995 },
  ]);

  await db.insert(payments).values([
    { id: "pay_a", tenantId: TENANT_A, orderId: "ord_a", amountCents: 13750, method: "stripe", status: "COMPLETED" },
    { id: "pay_b", tenantId: TENANT_B, orderId: "ord_b", amountCents: 54945, method: "bank_transfer" },
  ]);

  await db.insert(shippingRates).values([
    { id: "ship_a", tenantId: TENANT_A, carrier: "auspost", serviceName: "Parcel Post", rateCents: 1195 },
    { id: "ship_b", tenantId: TENANT_B, carrier: "sendle", serviceName: "Standard", rateCents: 990 },
  ]);

  await db.insert(activityLogs).values([
    { id: "log_a", tenantId: TENANT_A, userId: "user_a_admin", action: "order.created", entity: "order" },
    { id: "log_b", tenantId: TENANT_B, userId: "user_b_admin", action: "order.created", entity: "order" },
  ]);

  await db.insert(featureFlags).values([
    { id: "flag_a", tenantId: TENANT_A, key: "quotes", enabled: true },
    { id: "flag_b", tenantId: TENANT_B, key: "quotes", enabled: false },
  ]);

  return {
    productA: "prod_a",
    productB: "prod_b",
    orderA: "ord_a",
    orderB: "ord_b",
    lineItemA: "li_a",
    lineItemB: "li_b",
    cartA: "cart_a",
    cartB: "cart_b",
  };
}
