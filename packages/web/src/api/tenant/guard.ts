import { and, asc, count, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "../database";
import { orderLineItems, orders, TENANT_SCOPED_TABLES, tenants, users } from "../database/schema";
import { isSuperAdmin, requireRequestContext, type RequestContext, type Role } from "./context";

/**
 * THE TENANT GUARD — the application-layer replacement for PostgreSQL row-level security.
 *
 * Read this before using it, because the guarantee is genuinely weaker than what it replaces.
 * Under Postgres, `FORCE ROW LEVEL SECURITY` meant a service that forgot its `WHERE tenantId`
 * still could not see another tenant's rows: the database refused. Turso/SQLite has no RLS,
 * so that floor is gone. Here, a bug *in this file* is a cross-tenant data leak.
 *
 * Three things hold the line instead:
 *   1. This module is the only place allowed to import the raw Drizzle client. Everything
 *      else goes through `scopedDb()`, which cannot issue an unfiltered query.
 *      `verify-guard.ts` fails the build if any other file imports the client.
 *   2. Cross-tenant access exists but is named and greppable: `unscopedDb("<reason>")`.
 *   3. The isolation test suite asserts the "a service forgot the filter" case directly.
 *
 * The predicates below are ports of prisma/rls-policies.sql in the old repo, one for one.
 * Fail closed: a caller with no tenant and no super-admin role matches `NEVER` (`1 = 0`),
 * which returns zero rows rather than every row.
 */

/** A predicate that matches nothing. The fail-closed default. */
const NEVER: SQL = sql`1 = 0`;

/** The platform role, as stored in `users.role`. Kept in step with `Role` in ./context. */
const SUPER_ADMIN_ROLE: Role = "SUPER_ADMIN";

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

type Row<T extends SQLiteTable> = T["$inferSelect"];
type NewRow<T extends SQLiteTable> = T["$inferInsert"];

export interface FindOptions {
  where?: SQL;
  orderBy?: SQL | SQL[];
  limit?: number;
  offset?: number;
}

/** Every scoped table exposes the same surface. No method can escape its scope predicate. */
export interface ScopedTable<T extends SQLiteTable> {
  findMany(options?: FindOptions): Promise<Row<T>[]>;
  findFirst(options?: FindOptions): Promise<Row<T> | undefined>;
  findById(id: string): Promise<Row<T> | undefined>;
  count(where?: SQL): Promise<number>;
  insert(values: NewRow<T>): Promise<Row<T>>;
  insertMany(values: NewRow<T>[]): Promise<Row<T>[]>;
  update(where: SQL | undefined, values: Partial<NewRow<T>>): Promise<Row<T>[]>;
  updateById(id: string, values: Partial<NewRow<T>>): Promise<Row<T> | undefined>;
  delete(where?: SQL): Promise<Row<T>[]>;
  deleteById(id: string): Promise<Row<T> | undefined>;
  /** The predicate this helper injects into every statement. Exposed for the verifier. */
  readonly scope: SQL;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTable = SQLiteTable & Record<string, any>;
type AnyDb = typeof db;

interface ScopeConfig<T extends SQLiteTable> {
  table: T;
  /** Predicate applied to every select/update/delete. */
  scope: SQL;
  /** Columns forced onto every insert (e.g. tenantId). */
  stamp: Record<string, unknown>;
  /** Throws when the caller may not write the given row. Runs before the statement. */
  assertWritable: (values: Record<string, unknown>) => void | Promise<void>;
  /** Throws when the caller may not delete at all. Defaults to "anything in scope". */
  assertDeletable?: () => void;
  client: AnyDb;
}

function normaliseOrderBy(orderBy: FindOptions["orderBy"]): SQL[] {
  if (!orderBy) return [];
  return Array.isArray(orderBy) ? orderBy : [orderBy];
}

function makeScopedTable<T extends SQLiteTable>(config: ScopeConfig<T>): ScopedTable<T> {
  const { table, scope, stamp, assertWritable, assertDeletable, client } = config;
  const t = table as AnyTable;

  const withScope = (where?: SQL): SQL => (where ? (and(scope, where) as SQL) : scope);

  const applyStamp = (values: Record<string, unknown>): Record<string, unknown> => {
    for (const [column, forced] of Object.entries(stamp)) {
      const supplied = values[column];
      if (supplied !== undefined && supplied !== forced) {
        throw new TenantScopeError(
          `Refusing to write ${String(t[Symbol.for("drizzle:Name") as unknown as string] ?? "row")} with ` +
            `${column}=${String(supplied)} from a context scoped to ${String(forced)}.`,
        );
      }
    }
    return { ...values, ...stamp };
  };

  return {
    scope,

    async findMany(options: FindOptions = {}) {
      let query = client.select().from(t).where(withScope(options.where)) as any;
      const order = normaliseOrderBy(options.orderBy);
      if (order.length > 0) query = query.orderBy(...order);
      if (options.limit !== undefined) query = query.limit(options.limit);
      if (options.offset !== undefined) query = query.offset(options.offset);
      return (await query) as Row<T>[];
    },

    async findFirst(options: FindOptions = {}) {
      const rows = await this.findMany({ ...options, limit: 1 });
      return rows[0];
    },

    async findById(id: string) {
      const rows = (await client
        .select()
        .from(t)
        .where(withScope(eq(t.id, id)))
        .limit(1)) as Row<T>[];
      return rows[0];
    },

    async count(where?: SQL) {
      const rows = (await client
        .select({ value: count() })
        .from(t)
        .where(withScope(where))) as { value: number }[];
      return rows[0]?.value ?? 0;
    },

    async insert(values: NewRow<T>) {
      const rows = await this.insertMany([values]);
      const row = rows[0];
      if (!row) throw new TenantScopeError("Insert returned no row.");
      return row;
    },

    async insertMany(values: NewRow<T>[]) {
      if (values.length === 0) return [];
      const stamped: Record<string, unknown>[] = [];
      for (const value of values) {
        const record = value as Record<string, unknown>;
        await assertWritable(record);
        stamped.push(applyStamp(record));
      }
      return (await client.insert(t).values(stamped).returning()) as Row<T>[];
    },

    async update(where: SQL | undefined, values: Partial<NewRow<T>>) {
      const record = values as Record<string, unknown>;
      await assertWritable(record);
      // Stamped columns are never re-assignable through an update.
      const patch = { ...record };
      for (const column of Object.keys(stamp)) delete patch[column];
      // A patch of nothing but stamped columns (e.g. an attempt to re-home a row into another
      // tenant) reduces to an empty SET, which Drizzle rejects outright. The write is a no-op
      // by design, so report the rows it would have matched and leave them untouched.
      if (Object.keys(patch).length === 0) {
        return (await client.select().from(t).where(withScope(where))) as Row<T>[];
      }
      return (await client.update(t).set(patch).where(withScope(where)).returning()) as Row<T>[];
    },

    async updateById(id: string, values: Partial<NewRow<T>>) {
      const rows = await this.update(eq(t.id, id), values);
      return rows[0];
    },

    async delete(where?: SQL) {
      assertDeletable?.();
      return (await client.delete(t).where(withScope(where)).returning()) as Row<T>[];
    },

    async deleteById(id: string) {
      const rows = await this.delete(eq(t.id, id));
      return rows[0];
    },
  };
}

// ============================================================================
// Predicates — direct ports of prisma/rls-policies.sql
// ============================================================================

/** `tenant_matches("tenantId")` */
function tenantMatches(ctx: RequestContext, column: AnyTable[string]): SQL {
  if (isSuperAdmin(ctx)) return sql`1 = 1`;
  if (!ctx.tenantId) return NEVER;
  return eq(column, ctx.tenantId);
}

/**
 * `order_line_item_policy` — OrderLineItem has no tenantId; scope through its parent order.
 * Expressed as `orderId IN (SELECT id FROM orders WHERE tenantId = ?)`, the SQLite-friendly
 * form of the original `EXISTS (SELECT 1 FROM "Order" o WHERE ...)`.
 */
function lineItemScope(ctx: RequestContext, client: AnyDb): SQL {
  if (isSuperAdmin(ctx)) return sql`1 = 1`;
  if (!ctx.tenantId) return NEVER;
  return inArray(
    orderLineItems.orderId,
    client.select({ id: orders.id }).from(orders).where(eq(orders.tenantId, ctx.tenantId)),
  );
}

/**
 * `tenant_select_policy` — deliberately open while no tenant context exists, because the API
 * resolves `{subdomain}.host -> tenant id` before any context can be established. Once a
 * context is set the caller is pinned to their own row.
 */
function tenantSelfScope(ctx: RequestContext): SQL {
  if (isSuperAdmin(ctx)) return sql`1 = 1`;
  if (!ctx.tenantId) return sql`1 = 1`;
  return eq(tenants.id, ctx.tenantId);
}

/**
 * `user_policy` — self (needed to bootstrap auth before the tenant is known), plus the
 * caller's tenant, plus unassigned users so a tenant admin can claim one.
 *
 * DELIBERATE DEVIATION from the old policy, approved by the user. The original read
 * `("tenantId" IS NULL AND current_tenant_id() IS NOT NULL)`, which exposed *every* tenant-null
 * user to *any* tenant admin — including the platform SUPER_ADMIN row, which is tenant-null by
 * definition. A tenant admin could therefore read it and claim it into their own tenant. The
 * unassigned clause now excludes super admins. This is the one place the guard is intentionally
 * stricter than the RLS it replaces.
 */
function userScope(ctx: RequestContext): SQL {
  if (isSuperAdmin(ctx)) return sql`1 = 1`;
  const clauses: SQL[] = [];
  if (ctx.userId) clauses.push(eq(users.id, ctx.userId));
  if (ctx.tenantId) {
    clauses.push(eq(users.tenantId, ctx.tenantId));
    clauses.push(and(isNull(users.tenantId), ne(users.role, SUPER_ADMIN_ROLE)) as SQL);
  }
  if (clauses.length === 0) return NEVER;
  return or(...clauses) as SQL;
}

function userRowIsWritable(ctx: RequestContext, values: Record<string, unknown>): boolean {
  if (isSuperAdmin(ctx)) return true;
  // No tenant-level caller may mint or promote a platform super admin.
  if (values.role === SUPER_ADMIN_ROLE) return false;
  if (ctx.userId && values.id === ctx.userId) return true;
  const rowTenant = values.tenantId;
  if (rowTenant != null && rowTenant === ctx.tenantId) return true;
  if (rowTenant == null && ctx.tenantId) return true;
  return false;
}

// ============================================================================
// scopedDb
// ============================================================================

type GenericTables = typeof TENANT_SCOPED_TABLES;

export type ScopedDb = {
  [K in keyof GenericTables]: ScopedTable<GenericTables[K]>;
} & {
  orderLineItems: ScopedTable<typeof orderLineItems>;
  tenants: ScopedTable<typeof tenants>;
  users: ScopedTable<typeof users>;
  /** The context these helpers were built from. */
  readonly ctx: RequestContext;
};

/**
 * Every table, pre-filtered to `ctx`'s tenant. This is the only database surface application
 * code may touch.
 *
 * The context is snapshotted synchronously here, so the returned helpers stay bound to the
 * right tenant even if a caller awaits them after leaving the AsyncLocalStorage scope.
 */
export function scopedDb(ctx?: RequestContext, client: AnyDb = db): ScopedDb {
  const c = ctx ?? requireRequestContext();

  const generic = {} as Record<string, ScopedTable<SQLiteTable>>;
  for (const [name, table] of Object.entries(TENANT_SCOPED_TABLES)) {
    const t = table as AnyTable;
    if (!t.tenantId) {
      throw new TenantScopeError(`TENANT_SCOPED_TABLES."${name}" has no tenantId column.`);
    }
    generic[name] = makeScopedTable({
      table,
      client,
      scope: tenantMatches(c, t.tenantId),
      // Super admins write across tenants, so nothing is forced for them — but they must say
      // which tenant they mean. Everyone else gets their own tenant stamped on.
      stamp: isSuperAdmin(c) ? {} : { tenantId: c.tenantId },
      assertWritable: (values) => {
        if (isSuperAdmin(c)) {
          if (values.tenantId == null) {
            throw new TenantScopeError(
              `Super-admin writes to "${name}" must name a tenantId explicitly; there is no ambient tenant.`,
            );
          }
          return;
        }
        if (!c.tenantId) {
          throw new TenantScopeError(`Cannot write "${name}" without a tenant context.`);
        }
      },
    });
  }

  const lineItems = makeScopedTable({
    table: orderLineItems,
    client,
    scope: lineItemScope(c, client),
    stamp: {},
    assertWritable: async (values) => {
      if (isSuperAdmin(c)) return;
      if (!c.tenantId) throw new TenantScopeError("Cannot write order line items without a tenant context.");
      const orderId = values.orderId;
      // An update patch need not carry orderId; the scope predicate already constrains it.
      if (orderId === undefined) return;
      if (typeof orderId !== "string") {
        throw new TenantScopeError("Order line item requires a string orderId.");
      }
      const parent = await client
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, c.tenantId)))
        .limit(1);
      if (parent.length === 0) {
        throw new TenantScopeError(`Order ${orderId} does not belong to tenant ${c.tenantId}.`);
      }
    },
  });

  const tenantsTable = makeScopedTable({
    table: tenants,
    client,
    scope: tenantSelfScope(c),
    stamp: {},
    assertWritable: () => {
      // tenant_insert_policy: any authenticated user may create a tenant (self-service signup
      // creates it before the caller belongs to one).
      if (isSuperAdmin(c)) return;
      if (!c.userId) throw new TenantScopeError("Only an authenticated user can create or change a tenant.");
    },
    // tenant_delete_policy: super admins only.
    assertDeletable: () => {
      if (!isSuperAdmin(c)) throw new TenantScopeError("Only a super admin can delete a tenant.");
    },
  });

  const usersTable = makeScopedTable({
    table: users,
    client,
    scope: userScope(c),
    stamp: {},
    assertWritable: (values) => {
      if (!userRowIsWritable(c, values)) {
        throw new TenantScopeError("Refusing to write a user row outside the caller's scope.");
      }
    },
  });

  return {
    ...(generic as { [K in keyof GenericTables]: ScopedTable<GenericTables[K]> }),
    orderLineItems: lineItems,
    tenants: tenantsTable,
    users: usersTable,
    ctx: c,
  };
}

/**
 * Deliberate cross-tenant access. The raw Drizzle client, unfiltered.
 *
 * Every call must state why, so `rg 'unscopedDb\('` lists the complete set of places that can
 * see across tenants. Reserved for the mothership (SUPER_ADMIN) console, migrations, and
 * host -> tenant routing. If you are reaching for this inside a tenant feature, it is a bug.
 */
export function unscopedDb(reason: string): AnyDb {
  if (!reason || reason.trim().length < 8) {
    throw new TenantScopeError("unscopedDb(reason) requires a real reason describing the cross-tenant access.");
  }
  return db;
}

// ============================================================================
// deleteTenantCascade
// ============================================================================

/**
 * The order tenant-scoped rows must be deleted in, children before parents.
 *
 * Verified against the foreign-key graph in ../database/schema.ts. It lives here rather than in
 * the mothership route for the same reason the scope predicates do: deleting across a tenant is
 * a scoping concern, and a route that assembled its own delete order could get it wrong quietly.
 *
 * `verify-guard.ts` fails the build if any table in TENANT_SCOPED_TABLES is missing from this
 * list, so a new tenant-scoped table cannot silently leave orphaned rows behind.
 */
export const TENANT_DELETE_ORDER = [
  "payments",
  "orders",
  "cartItems",
  "carts",
  "inventoryEvents",
  "priceTiers",
  "products",
  "categories",
  "companies",
  "shippingRates",
  "activityLogs",
  "featureFlags",
] as const satisfies readonly (keyof typeof TENANT_SCOPED_TABLES)[];

/** SQLite caps bound variables per statement; delete parent ids in batches well under it. */
const DELETE_CHUNK = 500;

export interface TenantCascadeResult {
  tenantId: string;
  /** Rows removed per table, keyed by the guard's table name. */
  deleted: Record<string, number>;
  total: number;
}

/**
 * Delete a tenant and everything belonging to it. SUPER_ADMIN only.
 *
 * This is the one destructive cross-tenant operation in the system, so it lives next to the
 * scope predicates instead of in a route: the delete order, the super-admin gate and the
 * all-or-nothing transaction are all scoping guarantees, and a caller assembling them by hand
 * would be a leak of a different kind — orphaned rows carrying a dead tenantId.
 *
 * Sessions and accounts are not deleted here: `session.userId` and `account.userId` both carry
 * `onDelete: "cascade"`, so removing the tenant's user rows takes them with it.
 *
 * NOT exposed in the mothership UI. The old admin console had no delete button — only Suspend,
 * Reactivate and Open as tenant — so a destructive control would be unrequested scope. This is
 * the tested primitive an operator can call deliberately; wiring a button to it is a decision
 * for whoever asks for one.
 */
export async function deleteTenantCascade(
  ctx: RequestContext,
  tenantId: string,
  client: AnyDb = db,
): Promise<TenantCascadeResult> {
  if (!isSuperAdmin(ctx)) {
    throw new TenantScopeError("Only a platform super admin may delete a tenant.");
  }
  if (!tenantId || tenantId.trim().length === 0) {
    throw new TenantScopeError("deleteTenantCascade requires a tenantId.");
  }

  const missing = Object.keys(TENANT_SCOPED_TABLES).filter(
    (name) => !(TENANT_DELETE_ORDER as readonly string[]).includes(name),
  );
  if (missing.length > 0) {
    throw new TenantScopeError(
      `TENANT_DELETE_ORDER is missing tenant-scoped tables: ${missing.join(", ")}. ` +
        "Add them in child-before-parent order or deleting a tenant will orphan their rows.",
    );
  }

  return client.transaction(async (tx) => {
    const deleted: Record<string, number> = {};

    // Line items have no tenantId of their own — they are reached through their parent orders,
    // exactly as lineItemScope() does, and must go before the orders they hang off.
    const orderIds = (
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.tenantId, tenantId))
    ).map((row) => row.id);

    let lineItems = 0;
    for (let i = 0; i < orderIds.length; i += DELETE_CHUNK) {
      const chunk = orderIds.slice(i, i + DELETE_CHUNK);
      const removed = await tx
        .delete(orderLineItems)
        .where(inArray(orderLineItems.orderId, chunk))
        .returning({ id: orderLineItems.id });
      lineItems += removed.length;
    }
    deleted.orderLineItems = lineItems;

    for (const name of TENANT_DELETE_ORDER) {
      const table = TENANT_SCOPED_TABLES[name] as AnyTable;
      const removed = await tx
        .delete(table)
        .where(eq(table.tenantId, tenantId))
        .returning({ id: table.id });
      deleted[name] = removed.length;
    }

    const removedUsers = await tx
      .delete(users)
      .where(eq(users.tenantId, tenantId))
      .returning({ id: users.id });
    deleted.users = removedUsers.length;

    const removedTenants = await tx
      .delete(tenants)
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id });
    deleted.tenants = removedTenants.length;

    const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
    return { tenantId, deleted, total };
  });
}

/**
 * A scoped database inside a single transaction. Everything the callback writes commits
 * together or not at all.
 *
 * This exists because checkout is the one flow where a partial write is genuinely damaging:
 * the old stack ran it inside `withRlsTransaction`, and without an equivalent here a failure
 * halfway through could leave an order with no line items, or an emptied cart with no order.
 * The scoping rules are unchanged — the same predicates, stamps and write assertions are
 * rebuilt over the transaction's client, so a transaction cannot be used to widen scope.
 *
 * Keep the callback short and free of network calls. An open transaction holds a connection.
 */
export async function withScopedTransaction<T>(
  ctx: RequestContext,
  fn: (tx: ScopedDb) => Promise<T>,
  client: AnyDb = db,
): Promise<T> {
  return client.transaction(async (tx) => fn(scopedDb(ctx, tx as unknown as AnyDb)));
}

/** Convenience for orderings, so callers never need the raw drizzle-orm import for it. */
export { asc, eq, and, or, sql };
