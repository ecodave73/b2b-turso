import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { activityLogs, users as usersTable } from "../database/schema";
import { requireTenantId, tenantAdmin, tenantStaff } from "../middleware/auth";

/**
 * Activity log — the port of the old `listActivityLog` procedure.
 *
 * Rows are only ever written by the features that cause them (see the activityLogs.insert
 * calls across routes/*.ts); nothing here creates or edits an entry, because an audit trail
 * that callers can write freely is not an audit trail.
 *
 * Gate matches the old procedure exactly: TENANT_ADMIN and TENANT_STAFF (plus SUPER_ADMIN,
 * which passes every role gate). Buyers do not see the tenant's audit trail.
 *
 * Added over the old version: offset paging and an `actions` procedure, so the filter dropdown
 * lists the actions this tenant has actually recorded instead of a hardcoded array that drifts
 * out of date the moment a new action string is introduced.
 */

/**
 * Lowercase-dotted like every other action in the system (`order.created`, `product.updated`).
 * `activity.actions` feeds a filter dropdown the CUSTOMER sees, so a SHOUTY_CASE entry would
 * stand out as the one thing in that list written by someone else.
 */
const TENANT_ENTRY_ACTION = "tenant.viewed";

/** One entry per viewing session, roughly. Long enough to survive reloads and tab switches. */
const TENANT_ENTRY_DEDUPE_MS = 30 * 60 * 1000;

export const activity = {
  list: tenantStaff
    .input(
      z
        .object({
          action: z.string().trim().min(1).max(120).optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .prefault({}),
    )
    .handler(async ({ input, context }) => {
      requireTenantId(context.ctx);

      const where = input.action ? eq(activityLogs.action, input.action) : undefined;

      const [rows, total] = await Promise.all([
        context.db.activityLogs.findMany({
          where,
          orderBy: desc(activityLogs.createdAt),
          limit: input.limit,
          offset: input.offset,
        }),
        context.db.activityLogs.count(where),
      ]);

      // Actor emails, resolved in one scoped read. userScope keeps this inside the tenant, so a
      // log row pointing at a foreign user id simply resolves to null rather than leaking a name.
      const actorIds = [...new Set(rows.map((row) => row.userId).filter((id): id is string => !!id))];
      const actors = new Map<string, string>();
      if (actorIds.length > 0) {
        const actorRows = await context.db.users.findMany({ where: inArray(usersTable.id, actorIds) });
        for (const actor of actorRows) actors.set(actor.id, actor.email);
      }

      return {
        total,
        limit: input.limit,
        offset: input.offset,
        entries: rows.map((row) => ({
          id: row.id,
          action: row.action,
          entity: row.entity,
          entityId: row.entityId,
          details: row.details,
          userId: row.userId,
          userEmail: row.userId ? (actors.get(row.userId) ?? null) : null,
          createdAt: row.createdAt,
        })),
      };
    }),

  /**
   * Record that platform support opened this workspace. The audit half of "open as tenant".
   *
   * Gated on `tenantAdmin` rather than `superAdmin` on purpose: a super admin passes every role
   * base, so this needs no gate of its own, and a real tenant admin calling it simply gets the
   * no-op below. One gate, one behaviour to reason about.
   *
   * Three deliberate choices:
   *   · The entry lands in the VIEWED tenant's own log, because it is written through
   *     scopedDb(ctx) and the context carries their tenantId. The customer sees it on
   *     /activity — the same transparency the old stack gave, without the impersonation row.
   *   · `details` says "platform support", not the admin's user id. `activity.list` resolves
   *     actor emails through a scoped users read, and the super admin's row has tenantId null,
   *     so their email deliberately will not resolve inside this tenant. A label keeps the row
   *     legible to the customer without naming who on the platform side looked.
   *   · Dedupes on a 30-minute lookback, so a page reload or a StrictMode double-mount does not
   *     spam the trail. The dedupe is server-side precisely so the client needs no promise gate.
   *     There is no exit entry: an entry timestamp plus the window reconstructs the visit, and
   *     an exit log would need a server call on a flow whose entire point is that it has none.
   */
  logTenantEntry: tenantAdmin.handler(async ({ context }) => {
    const ctx = context.ctx;

    // A real tenant admin visiting their own workspace is not an event.
    if (!context.viewingAsTenant || !ctx.tenantId || !ctx.userId) return { logged: false };

    const since = new Date(Date.now() - TENANT_ENTRY_DEDUPE_MS);
    // The tenantId filter is NOT redundant. A super admin's scope predicate is `1 = 1` even when
    // ctx.tenantId is set (see tenantMatches in tenant/guard.ts), and a super admin is this
    // procedure's only real caller — so without it, opening tenant B within the dedupe window
    // after tenant A would match A's row and leave B with no audit entry at all.
    const recent = await context.db.activityLogs.findFirst({
      where: and(
        eq(activityLogs.tenantId, ctx.tenantId),
        eq(activityLogs.action, TENANT_ENTRY_ACTION),
        eq(activityLogs.userId, ctx.userId),
        gte(activityLogs.createdAt, since),
      ),
    });
    if (recent) return { logged: false };

    await context.db.activityLogs.insert({
      // Super admins have no ambient tenant, so the guard requires naming it explicitly.
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: TENANT_ENTRY_ACTION,
      entity: "tenant",
      entityId: ctx.tenantId,
      details: { by: "platform support" },
    });

    return { logged: true };
  }),

  /** Distinct action strings this tenant has recorded, alphabetically — feeds the filter. */
  actions: tenantStaff.handler(async ({ context }) => {
    requireTenantId(context.ctx);
    const rows = await context.db.activityLogs.findMany({});
    return [...new Set(rows.map((row) => row.action))].sort();
  }),
};
