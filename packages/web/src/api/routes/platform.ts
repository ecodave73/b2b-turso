import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import { z } from "zod";
import {
  activityLogs,
  featureFlags as featureFlagsTable,
  orders as ordersTable,
  products as productsTable,
  tenants as tenantsTable,
  users as usersTable,
} from "../database/schema";
import { superAdmin } from "../middleware/auth";
import { scopedDb, type ScopedDb } from "../tenant/guard";
import {
  dayKey,
  dayKeys,
  monthStart,
  mrrCentsFor,
  OPEN_STATUSES,
  PLAN_MRR_CENTS,
  PLANS,
  REVENUE_STATUSES,
  windowStart,
} from "../services/platform";

/**
 * The mothership — platform-wide console for SUPER_ADMIN. Port of the old `platformService.ts`
 * plus the four `/admin` procedures.
 *
 * Every procedure sits on the `superAdmin` base, so the role check is the middleware's, not a
 * literal comparison in here.
 *
 * TWO THINGS WORTH KNOWING BEFORE EDITING THIS FILE:
 *
 * 1. Reads go through `platformDb()`, not `context.db`. A super admin's scope predicates
 *    collapse to `1 = 1` only while no tenant is addressed; the moment one is (which is exactly
 *    what "open as tenant" does), `context.db` narrows to that tenant. Platform figures must
 *    never depend on which URL the admin happens to be on, so this builds a deliberately
 *    tenant-less context. Still the guard, still no raw client.
 *
 * 2. Return shapes are FLAT. The old procedures nested (`stats.tenants.total`,
 *    `stats.revenue.gmv`), which read fine in a service and badly in a component — every tile
 *    needed two lookups and an optional chain. Scalars are top level with a `Cents` suffix
 *    where they are money; arrays only where the data is genuinely list-shaped.
 *
 * Improvement over the old console: activity rows resolve their actor's email. The old one
 * rendered raw user ids, so "who did this" needed a separate database trip by hand.
 */

/**
 * Platform-wide scope: super admin, no tenant pinned. Every predicate renders `1 = 1`.
 *
 * Named rather than inlined so `rg 'platformDb'` lists every place that reads across tenants,
 * the same discipline `unscopedDb(reason)` enforces for the raw client.
 */
function platformDb(ctx: { userId: string | null }): ScopedDb {
  return scopedDb({ userId: ctx.userId, tenantId: null, role: "SUPER_ADMIN" });
}

const STATUS_FILTER = ["active", "suspended", "all"] as const;

/** 30-day window for the trend charts and the "last 30 days" figures. */
const TREND_DAYS = 30;

function tenantSummaryFields(tenant: typeof tenantsTable.$inferSelect) {
  return {
    id: tenant.id,
    name: tenant.name,
    subdomain: tenant.subdomain,
    customDomain: tenant.customDomain,
    domainStatus: tenant.domainStatus,
    plan: tenant.plan,
    isActive: tenant.isActive,
    isSandbox: tenant.isSandbox,
    brandColor: tenant.brandColor,
    logo: tenant.logo,
    createdAt: tenant.createdAt,
  };
}

async function loadTenantOr404(db: ScopedDb, tenantId: string) {
  const tenant = await db.tenants.findById(tenantId);
  if (!tenant) throw new ORPCError("NOT_FOUND", { message: "Tenant not found." });
  return tenant;
}

/** Actor emails for a set of log rows, resolved platform-wide (unlike the tenant's own view). */
async function resolveActors(db: ScopedDb, rows: { userId: string | null }[]) {
  const ids = [...new Set(rows.map((row) => row.userId).filter((id): id is string => !!id))];
  const emails = new Map<string, string>();
  if (ids.length === 0) return emails;
  const actors = await db.users.findMany({ where: inArray(usersTable.id, ids) });
  for (const actor of actors) emails.set(actor.id, actor.email);
  return emails;
}

export const platform = {
  /**
   * Everything the mothership overview renders, in one call.
   *
   * MRR is list price for the tenants on each plan (see PLAN_MRR_CENTS) — not collected
   * revenue, and not Stripe. The overview page labels it as such.
   */
  stats: superAdmin.handler(async ({ context }) => {
    const db = platformDb(context.ctx);

    const [tenantRows, userRows, orderRows] = await Promise.all([
      db.tenants.findMany({}),
      db.users.findMany({}),
      db.orders.findMany({}),
    ]);

    const since = windowStart(TREND_DAYS);
    const month = monthStart();

    const usersByRole = new Map<string, number>();
    for (const user of userRows) {
      usersByRole.set(user.role, (usersByRole.get(user.role) ?? 0) + 1);
    }

    const planCounts = new Map<string, { tenants: number; mrrCents: number }>();
    for (const plan of PLANS) planCounts.set(plan, { tenants: 0, mrrCents: 0 });
    for (const tenant of tenantRows) {
      const bucket = planCounts.get(tenant.plan) ?? { tenants: 0, mrrCents: 0 };
      bucket.tenants += 1;
      bucket.mrrCents += mrrCentsFor(tenant.plan, tenant.isActive);
      planCounts.set(tenant.plan, bucket);
    }

    const earned = orderRows.filter((order) => REVENUE_STATUSES.includes(order.status));
    const open = orderRows.filter((order) => OPEN_STATUSES.includes(order.status));
    const recentOrders = orderRows.filter((order) => order.createdAt >= since);

    const signupBuckets = new Map(dayKeys(TREND_DAYS).map((key) => [key, 0]));
    for (const tenant of tenantRows) {
      const key = dayKey(tenant.createdAt);
      if (signupBuckets.has(key)) signupBuckets.set(key, (signupBuckets.get(key) ?? 0) + 1);
    }

    const orderBuckets = new Map(
      dayKeys(TREND_DAYS).map((key) => [key, { orders: 0, revenueCents: 0 }]),
    );
    for (const order of recentOrders) {
      const bucket = orderBuckets.get(dayKey(order.createdAt));
      if (!bucket) continue;
      bucket.orders += 1;
      if (REVENUE_STATUSES.includes(order.status)) bucket.revenueCents += order.totalCents;
    }

    return {
      tenantsTotal: tenantRows.length,
      tenantsActive: tenantRows.filter((tenant) => tenant.isActive).length,
      tenantsSuspended: tenantRows.filter((tenant) => !tenant.isActive).length,
      tenantsSandbox: tenantRows.filter((tenant) => tenant.isSandbox).length,
      tenantsNewThisMonth: tenantRows.filter((tenant) => tenant.createdAt >= month).length,

      usersTotal: userRows.length,
      usersByRole: [...usersByRole.entries()]
        .map(([role, users]) => ({ role, users }))
        .sort((a, b) => a.role.localeCompare(b.role)),

      ordersTotal: orderRows.length,
      ordersLast30Days: recentOrders.length,
      gmvCents: earned.reduce((sum, order) => sum + order.totalCents, 0),
      gmvLast30DaysCents: recentOrders
        .filter((order) => REVENUE_STATUSES.includes(order.status))
        .reduce((sum, order) => sum + order.totalCents, 0),
      openValueCents: open.reduce((sum, order) => sum + order.totalCents, 0),
      currency: "AUD",

      mrrTotalCents: tenantRows.reduce(
        (sum, tenant) => sum + mrrCentsFor(tenant.plan, tenant.isActive),
        0,
      ),
      mrrByPlan: [...planCounts.entries()].map(([plan, bucket]) => ({
        plan,
        listPriceCents: PLAN_MRR_CENTS[plan] ?? 0,
        ...bucket,
      })),

      trendDays: TREND_DAYS,
      signupTrend: [...signupBuckets.entries()].map(([date, tenants]) => ({ date, tenants })),
      ordersTrend: [...orderBuckets.entries()].map(([date, bucket]) => ({ date, ...bucket })),
    };
  }),

  /**
   * The tenant list, with per-tenant counts and revenue.
   *
   * `search` is a LIKE over name / subdomain / custom domain. No ranking, no relevance — same
   * caveat as the catalogue until FTS5 lands, and the page says "matches" rather than "best
   * matches" so nobody reads an order into it.
   */
  tenants: superAdmin
    .input(
      z
        .object({
          search: z.string().trim().max(120).optional(),
          plan: z.enum(PLANS).optional(),
          status: z.enum(STATUS_FILTER).default("all"),
          includeSandbox: z.boolean().default(true),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .prefault({}),
    )
    .handler(async ({ input, context }) => {
      const db = platformDb(context.ctx);

      const clauses = [];
      if (input.plan) clauses.push(eq(tenantsTable.plan, input.plan));
      if (input.status !== "all") {
        clauses.push(eq(tenantsTable.isActive, input.status === "active"));
      }
      if (!input.includeSandbox) clauses.push(eq(tenantsTable.isSandbox, false));
      if (input.search) {
        const term = `%${input.search.toLowerCase()}%`;
        clauses.push(
          or(
            like(tenantsTable.name, term),
            like(tenantsTable.subdomain, term),
            like(tenantsTable.customDomain, term),
          )!,
        );
      }
      const where = clauses.length > 0 ? and(...clauses) : undefined;

      const [matched, total] = await Promise.all([
        db.tenants.findMany({
          where,
          orderBy: desc(tenantsTable.createdAt),
          limit: input.limit,
          offset: input.offset,
        }),
        db.tenants.count(where),
      ]);

      if (matched.length === 0) {
        return { total, limit: input.limit, offset: input.offset, tenants: [] };
      }

      // Counts for the matched page only. The guard has no joins and no group-by, so this is a
      // read-and-fold — bounded by the page size rather than the whole platform.
      const ids = matched.map((tenant) => tenant.id);
      const [userRows, productRows, orderRows, logRows] = await Promise.all([
        db.users.findMany({ where: inArray(usersTable.tenantId, ids) }),
        db.products.findMany({ where: inArray(productsTable.tenantId, ids) }),
        db.orders.findMany({ where: inArray(ordersTable.tenantId, ids) }),
        db.activityLogs.findMany({ where: inArray(activityLogs.tenantId, ids) }),
      ]);

      const tally = new Map(
        ids.map((id) => [
          id,
          { users: 0, products: 0, orders: 0, revenueCents: 0, lastActivityAt: null as Date | null },
        ]),
      );
      for (const user of userRows) {
        const bucket = user.tenantId ? tally.get(user.tenantId) : undefined;
        if (bucket) bucket.users += 1;
      }
      for (const product of productRows) {
        const bucket = tally.get(product.tenantId);
        if (bucket) bucket.products += 1;
      }
      for (const order of orderRows) {
        const bucket = tally.get(order.tenantId);
        if (!bucket) continue;
        bucket.orders += 1;
        if (REVENUE_STATUSES.includes(order.status)) bucket.revenueCents += order.totalCents;
      }
      for (const log of logRows) {
        const bucket = tally.get(log.tenantId);
        if (!bucket) continue;
        if (!bucket.lastActivityAt || log.createdAt > bucket.lastActivityAt) {
          bucket.lastActivityAt = log.createdAt;
        }
      }

      return {
        total,
        limit: input.limit,
        offset: input.offset,
        tenants: matched.map((tenant) => {
          const bucket = tally.get(tenant.id)!;
          return {
            ...tenantSummaryFields(tenant),
            userCount: bucket.users,
            productCount: bucket.products,
            orderCount: bucket.orders,
            revenueCents: bucket.revenueCents,
            mrrCents: mrrCentsFor(tenant.plan, tenant.isActive),
            lastActivityAt: bucket.lastActivityAt,
          };
        }),
      };
    }),

  /** One tenant, in full: counts, money, its people, its recent orders and its audit tail. */
  tenantDetail: superAdmin
    .input(z.object({ tenantId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const db = platformDb(context.ctx);
      const tenant = await loadTenantOr404(db, input.tenantId);

      const [userRows, productCount, orderRows, logRows, flagRows] = await Promise.all([
        db.users.findMany({
          where: eq(usersTable.tenantId, tenant.id),
          orderBy: asc(usersTable.createdAt),
          limit: 50,
        }),
        db.products.count(eq(productsTable.tenantId, tenant.id)),
        db.orders.findMany({
          where: eq(ordersTable.tenantId, tenant.id),
          orderBy: desc(ordersTable.createdAt),
        }),
        db.activityLogs.findMany({
          where: eq(activityLogs.tenantId, tenant.id),
          orderBy: desc(activityLogs.createdAt),
          limit: 20,
        }),
        db.featureFlags.findMany({
          where: eq(featureFlagsTable.tenantId, tenant.id),
          orderBy: asc(featureFlagsTable.key),
        }),
      ]);

      const byStatus = new Map<string, { orders: number; totalCents: number }>();
      for (const order of orderRows) {
        const bucket = byStatus.get(order.status) ?? { orders: 0, totalCents: 0 };
        bucket.orders += 1;
        bucket.totalCents += order.totalCents;
        byStatus.set(order.status, bucket);
      }

      const actors = await resolveActors(db, logRows);

      return {
        ...tenantSummaryFields(tenant),
        squareConnected: !!tenant.squareConnectionToken,
        stripeCustomerId: tenant.stripeCustomerId,
        billingConnected: !!tenant.stripeSubscriptionId,
        updatedAt: tenant.updatedAt,

        userCount: userRows.length,
        productCount,
        orderCount: orderRows.length,
        mrrCents: mrrCentsFor(tenant.plan, tenant.isActive),
        revenueCents: orderRows
          .filter((order) => REVENUE_STATUSES.includes(order.status))
          .reduce((sum, order) => sum + order.totalCents, 0),
        openOrderValueCents: orderRows
          .filter((order) => OPEN_STATUSES.includes(order.status))
          .reduce((sum, order) => sum + order.totalCents, 0),

        ordersByStatus: [...byStatus.entries()].map(([status, bucket]) => ({ status, ...bucket })),
        users: userRows.map((user) => ({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
        })),
        recentOrders: orderRows.slice(0, 10).map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          totalCents: order.totalCents,
          currency: order.currency,
          createdAt: order.createdAt,
        })),
        recentActivity: logRows.map((log) => ({
          id: log.id,
          action: log.action,
          entity: log.entity,
          entityId: log.entityId,
          details: log.details,
          userId: log.userId,
          userEmail: log.userId ? (actors.get(log.userId) ?? null) : null,
          createdAt: log.createdAt,
        })),
        featureFlags: flagRows.map((flag) => ({
          id: flag.id,
          key: flag.key,
          enabled: flag.enabled,
          updatedAt: flag.updatedAt,
        })),
      };
    }),

  /** The audit trail across every tenant, newest first. */
  activity: superAdmin
    .input(
      z
        .object({
          tenantId: z.string().min(1).optional(),
          entity: z.string().trim().min(1).max(60).optional(),
          search: z.string().trim().max(120).optional(),
          limit: z.number().int().min(1).max(500).default(100),
          offset: z.number().int().min(0).default(0),
        })
        .prefault({}),
    )
    .handler(async ({ input, context }) => {
      const db = platformDb(context.ctx);

      const clauses = [];
      if (input.tenantId) clauses.push(eq(activityLogs.tenantId, input.tenantId));
      if (input.entity) clauses.push(eq(activityLogs.entity, input.entity));
      if (input.search) clauses.push(like(activityLogs.action, `%${input.search.toLowerCase()}%`));
      const where = clauses.length > 0 ? and(...clauses) : undefined;

      const [rows, total] = await Promise.all([
        db.activityLogs.findMany({
          where,
          orderBy: desc(activityLogs.createdAt),
          limit: input.limit,
          offset: input.offset,
        }),
        db.activityLogs.count(where),
      ]);

      const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
      const [tenantRows, actors] = await Promise.all([
        tenantIds.length > 0
          ? db.tenants.findMany({ where: inArray(tenantsTable.id, tenantIds) })
          : Promise.resolve([]),
        resolveActors(db, rows),
      ]);
      const tenantsById = new Map(tenantRows.map((tenant) => [tenant.id, tenant]));

      return {
        total,
        limit: input.limit,
        offset: input.offset,
        entries: rows.map((row) => {
          const tenant = tenantsById.get(row.tenantId);
          return {
            id: row.id,
            tenantId: row.tenantId,
            tenantName: tenant?.name ?? null,
            tenantSubdomain: tenant?.subdomain ?? null,
            action: row.action,
            entity: row.entity,
            entityId: row.entityId,
            details: row.details,
            userId: row.userId,
            userEmail: row.userId ? (actors.get(row.userId) ?? null) : null,
            createdAt: row.createdAt,
          };
        }),
      };
    }),

  /**
   * Suspend or reactivate a tenant. This is the switch the suspension check in `withTenant`
   * has been waiting for — until now the only way to flip `isActive` was raw SQL.
   *
   * `isActive` is an OPS switch, never a billing one. A tenant behind on payment is a phase-6b
   * `subscriptionStatus` problem that should degrade gracefully; suspension cuts access
   * outright for everyone but a super admin.
   *
   * Dropped from the old version: its "the platform tenant cannot be suspended" guard, which
   * checked for `subdomain === "admin"`. `admin` is in RESERVED_SUBDOMAINS, so no tenant can
   * hold it and the branch is unreachable by construction.
   */
  setTenantActive: superAdmin
    .input(
      z.object({
        tenantId: z.string().min(1),
        isActive: z.boolean(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const db = platformDb(context.ctx);
      const tenant = await loadTenantOr404(db, input.tenantId);

      if (tenant.isActive === input.isActive) {
        return { ...tenantSummaryFields(tenant), changed: false };
      }

      const updated = await db.tenants.updateById(tenant.id, {
        isActive: input.isActive,
        updatedAt: new Date(),
      });
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Tenant not found." });

      await db.activityLogs.insert({
        tenantId: tenant.id,
        userId: context.ctx.userId,
        action: input.isActive ? "tenant.reactivated" : "tenant.suspended",
        entity: "tenant",
        entityId: tenant.id,
        details: {
          previous: tenant.isActive,
          next: input.isActive,
          reason: input.reason ?? null,
          by: "platform support",
        },
      });

      return { ...tenantSummaryFields(updated), changed: true };
    }),

  /**
   * Move a tenant between plans. Records the MRR delta on the entry, as the old service did,
   * so the audit trail shows the commercial effect and not just the label change.
   *
   * Still list price, not billing: no Stripe subscription is touched here. Phase 6b is where
   * a plan change becomes a real proration.
   */
  updateTenantPlan: superAdmin
    .input(z.object({ tenantId: z.string().min(1), plan: z.enum(PLANS) }))
    .handler(async ({ input, context }) => {
      const db = platformDb(context.ctx);
      const tenant = await loadTenantOr404(db, input.tenantId);

      if (tenant.plan === input.plan) {
        return { ...tenantSummaryFields(tenant), changed: false };
      }

      const updated = await db.tenants.updateById(tenant.id, {
        plan: input.plan,
        updatedAt: new Date(),
      });
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Tenant not found." });

      await db.activityLogs.insert({
        tenantId: tenant.id,
        userId: context.ctx.userId,
        action: "tenant.plan_changed",
        entity: "tenant",
        entityId: tenant.id,
        details: {
          previous: tenant.plan,
          next: input.plan,
          mrrDeltaCents:
            mrrCentsFor(input.plan, tenant.isActive) - mrrCentsFor(tenant.plan, tenant.isActive),
          by: "platform support",
        },
      });

      return { ...tenantSummaryFields(updated), changed: true };
    }),
};
