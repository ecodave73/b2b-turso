import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Multi-tenant B2B platform schema — ported from Prisma/PostgreSQL to Drizzle/SQLite.
 *
 * THREE CONVENTIONS THAT DIFFER FROM THE POSTGRES ORIGINAL. Read before adding columns.
 *
 * 1. MONEY IS INTEGER MINOR UNITS (cents). SQLite has no DECIMAL type, and floats silently
 *    lose cents. Every money column is `integer` holding cents and is suffixed `Cents`.
 *    Format at the UI/API edge only — never do arithmetic on a formatted value.
 * 2. RATES ARE BASIS POINTS. `taxRateBp` 1000 = 10.00%. Integer, so no rounding drift.
 * 3. WEIGHT IS GRAMS (integer), not kilograms.
 *
 * Every tenant-scoped table carries `tenantId`. The ONE exception is `orderLineItems`,
 * which is scoped through its parent order — mirroring the old RLS policy. The tenant guard
 * in ../tenant/guard.ts encodes that exception explicitly.
 *
 * Dropped from the original: `Product.searchVector` (PostgreSQL tsvector). SQLite would need
 * an FTS5 virtual table; search is a LIKE filter until that is built.
 */

/** Opaque primary keys. Existing cuid values from the Postgres database import unchanged. */
const primaryId = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

type Json = Record<string, unknown>;

// ============================================================================
// Tenant — the root of every scope
// ============================================================================

export const tenants = sqliteTable(
  "tenants",
  {
    id: primaryId(),
    subdomain: text("subdomain").notNull(),
    customDomain: text("custom_domain"),
    /** pending_verification | active | certificate_error */
    domainStatus: text("domain_status"),
    domainVerifiedAt: integer("domain_verified_at", { mode: "timestamp" }),
    sslExpiresAt: integer("ssl_expires_at", { mode: "timestamp" }),
    name: text("name").notNull(),
    logo: text("logo"),
    brandColor: text("brand_color").notNull().default("#1a1a2e"),
    /** starter | professional | enterprise */
    plan: text("plan").notNull().default("starter"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** Square is deferred — columns retained so tenant records migrate without loss. */
    squareConnectionToken: text("square_connection_token"),
    squareLocationId: text("square_location_id"),
    isSandbox: integer("is_sandbox", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tenants_subdomain_uq").on(t.subdomain),
    uniqueIndex("tenants_custom_domain_uq").on(t.customDomain),
    index("tenants_plan_idx").on(t.plan),
    index("tenants_is_active_idx").on(t.isActive),
  ],
);

// ============================================================================
// User — tenantId is nullable: a user exists before being assigned to a tenant
// ============================================================================

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    image: text("image"),
    handle: text("handle"),
    /**
     * NOT NULL and unique — Better Auth owns this table as its `user` model and requires both.
     * The Prisma original allowed null; starting clean means no rows to backfill.
     */
    email: text("email").notNull(),
    /** Better Auth requirement. */
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    phone: text("phone"),
    tenantId: text("tenant_id").references(() => tenants.id),
    /** SUPER_ADMIN | TENANT_ADMIN | TENANT_STAFF | TENANT_CLIENT */
    role: text("role").notNull().default("TENANT_CLIENT"),
    dataRetentionDate: integer("data_retention_date", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    index("users_tenant_id_idx").on(t.tenantId),
    index("users_role_idx").on(t.role),
  ],
);

export const companies = sqliteTable(
  "companies",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    /** Australian Business Number */
    abn: text("abn"),
    address: text("address"),
    email: text("email"),
    phone: text("phone"),
    dataRetentionDate: integer("data_retention_date", { mode: "timestamp" }),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("companies_tenant_id_idx").on(t.tenantId)],
);

// ============================================================================
// Catalog
// ============================================================================

export const categories = sqliteTable(
  "categories",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    /** Self-referencing tree. No FK callback — SQLite resolves it at table level. */
    parentId: text("parent_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("categories_tenant_slug_uq").on(t.tenantId, t.slug),
    index("categories_tenant_id_idx").on(t.tenantId),
    index("categories_tenant_parent_idx").on(t.tenantId, t.parentId),
  ],
);

export const products = sqliteTable(
  "products",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    categoryId: text("category_id").references(() => categories.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    unitPriceCents: integer("unit_price_cents").notNull(),
    costPriceCents: integer("cost_price_cents"),
    /** Basis points: 1000 = 10.00% */
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    /** Minimum order quantity */
    moq: integer("moq").notNull().default(1),
    weightGrams: integer("weight_grams"),
    /** "LxWxH" in cm */
    dimensions: text("dimensions"),
    /** Array of CDN URLs */
    images: text("images", { mode: "json" }).$type<string[]>(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_tenant_sku_uq").on(t.tenantId, t.sku),
    index("products_tenant_id_idx").on(t.tenantId),
    index("products_tenant_active_idx").on(t.tenantId, t.isActive),
    index("products_tenant_category_idx").on(t.tenantId, t.categoryId),
  ],
);

/** Event-sourced inventory — immutable. Never mutate stock directly; append an event. */
export const inventoryEvents = sqliteTable(
  "inventory_events",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    /** RECEIVED | SOLD | ADJUSTED | RETURNED | TRANSFERRED */
    eventType: text("event_type").notNull(),
    /** Signed delta — positive or negative */
    quantity: integer("quantity").notNull(),
    /** orderId, adjustmentId, etc. */
    reference: text("reference"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("inventory_events_tenant_product_idx").on(t.tenantId, t.productId),
    index("inventory_events_tenant_product_created_idx").on(t.tenantId, t.productId, t.createdAt),
  ],
);

export const priceTiers = sqliteTable(
  "price_tiers",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    minQty: integer("min_qty").notNull().default(1),
    /** null = unlimited */
    maxQty: integer("max_qty"),
    unitPriceCents: integer("unit_price_cents").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("price_tiers_tenant_product_idx").on(t.tenantId, t.productId),
    index("price_tiers_tenant_product_min_idx").on(t.tenantId, t.productId, t.minQty),
  ],
);

// ============================================================================
// Orders
// ============================================================================

export const orders = sqliteTable(
  "orders",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderNumber: text("order_number").notNull(),
    companyId: text("company_id").references(() => companies.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** DRAFT | PENDING | CONFIRMED | SHIPPED | INVOICED | PAID | CLOSED | CANCELLED */
    status: text("status").notNull().default("DRAFT"),
    /** QUOTE_SENT | NEGOTIATING | COUNTERED */
    quoteStatus: text("quote_status"),
    /** Purchase order number supplied by the client */
    poNumber: text("po_number"),
    shippingAddress: text("shipping_address"),
    shippingMethod: text("shipping_method"),
    shippingCostCents: integer("shipping_cost_cents"),
    subtotalCents: integer("subtotal_cents").notNull(),
    taxTotalCents: integer("tax_total_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    currency: text("currency").notNull().default("AUD"),
    notes: text("notes"),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_order_number_uq").on(t.orderNumber),
    index("orders_tenant_id_idx").on(t.tenantId),
    index("orders_tenant_status_idx").on(t.tenantId, t.status),
    index("orders_tenant_status_created_idx").on(t.tenantId, t.status, t.createdAt),
  ],
);

/**
 * NO tenantId — deliberately. Scoped through its parent order, exactly as the old
 * PostgreSQL RLS policy did. The tenant guard enforces this via a parent-order join.
 */
export const orderLineItems = sqliteTable(
  "order_line_items",
  {
    id: primaryId(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    /** Price at time of order — snapshot, never recomputed */
    unitPriceCents: integer("unit_price_cents").notNull(),
    totalPriceCents: integer("total_price_cents").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
  },
  (t) => [index("order_line_items_order_id_idx").on(t.orderId)],
);

// ============================================================================
// Cart
// ============================================================================

export const carts = sqliteTable(
  "carts",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("carts_tenant_user_uq").on(t.tenantId, t.userId),
    index("carts_tenant_id_idx").on(t.tenantId),
  ],
);

export const cartItems = sqliteTable(
  "cart_items",
  {
    id: primaryId(),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    /** Snapshot at add time */
    priceCents: integer("price_cents").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
  },
  (t) => [index("cart_items_cart_id_idx").on(t.cartId), index("cart_items_tenant_id_idx").on(t.tenantId)],
);

// ============================================================================
// Payments, shipping, audit, flags
// ============================================================================

export const payments = sqliteTable(
  "payments",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    amountCents: integer("amount_cents").notNull(),
    /** credit_card | bank_transfer | stripe | square */
    method: text("method").notNull(),
    /** PENDING | COMPLETED | FAILED | REFUNDED */
    status: text("status").notNull().default("PENDING"),
    /** Stripe payment intent id, Square charge id, etc. */
    reference: text("reference"),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
  },
  (t) => [index("payments_tenant_id_idx").on(t.tenantId), index("payments_tenant_order_idx").on(t.tenantId, t.orderId)],
);

export const shippingRates = sqliteTable(
  "shipping_rates",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** auspost | sendle | manual */
    carrier: text("carrier").notNull(),
    serviceName: text("service_name").notNull(),
    rateCents: integer("rate_cents").notNull(),
    /** e.g. "1-2 business days" */
    estimatedDays: text("estimated_days"),
    /** Weight/dimension limits */
    conditions: text("conditions", { mode: "json" }).$type<Json>(),
    isFallback: integer("is_fallback", { mode: "boolean" }).notNull().default(false),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("shipping_rates_tenant_carrier_idx").on(t.tenantId, t.carrier)],
);

export const activityLogs = sqliteTable(
  "activity_logs",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: text("user_id"),
    /** order.created | product.updated | tenant.suspended | etc. */
    action: text("action").notNull(),
    /** order | product | user | tenant | payment */
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    details: text("details", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_logs_tenant_id_idx").on(t.tenantId),
    index("activity_logs_tenant_action_idx").on(t.tenantId, t.action),
    index("activity_logs_tenant_action_created_idx").on(t.tenantId, t.action, t.createdAt),
  ],
);

export const featureFlags = sqliteTable(
  "feature_flags",
  {
    id: primaryId(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    key: text("key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    metadata: text("metadata", { mode: "json" }).$type<Json>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("feature_flags_tenant_key_uq").on(t.tenantId, t.key),
    index("feature_flags_tenant_id_idx").on(t.tenantId),
  ],
);

// ============================================================================
// Relations
// ============================================================================

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  companies: many(companies),
  categories: many(categories),
  products: many(products),
  orders: many(orders),
  carts: many(carts),
  payments: many(payments),
  shippingRates: many(shippingRates),
  activityLogs: many(activityLogs),
  featureFlags: many(featureFlags),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
  orders: many(orders),
  carts: many(carts),
}));

export const companiesRelations = relations(companies, ({ one, many }) => ({
  tenant: one(tenants, { fields: [companies.tenantId], references: [tenants.id] }),
  orders: many(orders),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  tenant: one(tenants, { fields: [categories.tenantId], references: [tenants.id] }),
  parent: one(categories, { fields: [categories.parentId], references: [categories.id], relationName: "categoryTree" }),
  children: many(categories, { relationName: "categoryTree" }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  tenant: one(tenants, { fields: [products.tenantId], references: [tenants.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  inventoryEvents: many(inventoryEvents),
  priceTiers: many(priceTiers),
  orderLineItems: many(orderLineItems),
  cartItems: many(cartItems),
}));

export const inventoryEventsRelations = relations(inventoryEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [inventoryEvents.tenantId], references: [tenants.id] }),
  product: one(products, { fields: [inventoryEvents.productId], references: [products.id] }),
}));

export const priceTiersRelations = relations(priceTiers, ({ one }) => ({
  tenant: one(tenants, { fields: [priceTiers.tenantId], references: [tenants.id] }),
  product: one(products, { fields: [priceTiers.productId], references: [products.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  tenant: one(tenants, { fields: [orders.tenantId], references: [tenants.id] }),
  company: one(companies, { fields: [orders.companyId], references: [companies.id] }),
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  lineItems: many(orderLineItems),
  payments: many(payments),
}));

export const orderLineItemsRelations = relations(orderLineItems, ({ one }) => ({
  order: one(orders, { fields: [orderLineItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderLineItems.productId], references: [products.id] }),
}));

export const cartsRelations = relations(carts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [carts.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [carts.userId], references: [users.id] }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
  tenant: one(tenants, { fields: [cartItems.tenantId], references: [tenants.id] }),
  product: one(products, { fields: [cartItems.productId], references: [products.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  tenant: one(tenants, { fields: [payments.tenantId], references: [tenants.id] }),
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));

export const shippingRatesRelations = relations(shippingRates, ({ one }) => ({
  tenant: one(tenants, { fields: [shippingRates.tenantId], references: [tenants.id] }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  tenant: one(tenants, { fields: [activityLogs.tenantId], references: [tenants.id] }),
}));

export const featureFlagsRelations = relations(featureFlags, ({ one }) => ({
  tenant: one(tenants, { fields: [featureFlags.tenantId], references: [tenants.id] }),
}));

/**
 * Every generically tenant-scoped table, keyed by the name the guard exposes. Each value is
 * the table itself; the guard filters on its `tenantId` column.
 *
 * Deliberately absent:
 *   - `orderLineItems` — no tenant column, reached through its parent order (see lineItemScope)
 *   - `tenants` — self-scoping, open before a tenant is resolved so host->tenant routing works
 *   - `users` — self OR same-tenant OR unassigned, needed for claiming
 * ../tenant/guard.ts and ../tenant/verify-guard.ts both read this map, so adding a table here
 * is what makes it enforceable.
 */
export const TENANT_SCOPED_TABLES = {
  companies,
  categories,
  products,
  inventoryEvents,
  priceTiers,
  orders,
  carts,
  cartItems,
  payments,
  shippingRates,
  activityLogs,
  featureFlags,
} as const;
