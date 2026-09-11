/**
 * Platform (mothership) domain rules — the parts of the old `platformService.ts` that are
 * arithmetic rather than queries.
 *
 * The old service ran ~14 parallel Prisma aggregates per dashboard load. The scoped guard
 * exposes no aggregate beyond `count` and no joins, so the new mothership reads rows and folds
 * them here. That is a deliberate trade (correctness and isolation over query count): if the
 * volume ever outgrows it, the fix is an aggregate method on the guard, never a raw client in
 * a route.
 *
 * Money is cents everywhere, as it is across the rest of this codebase. The old service carried
 * plan prices as whole AUD dollars (`PLAN_MRR = { starter: 49 }`), which is exactly the kind of
 * mixed-unit arithmetic that eventually produces a wrong invoice.
 */

/** The plans a tenant can be on. Single source of truth — signup and the mothership share it. */
export const PLANS = ["starter", "professional", "enterprise"] as const;

export type Plan = (typeof PLANS)[number];

/**
 * List price per plan, in cents per month.
 *
 * NOTE: this is a price list, not billing truth. Nothing here talks to Stripe yet, so MRR is
 * "what these tenants would pay at list price", not "what was collected". Phase 6b replaces it
 * with real subscription state; until then the mothership dashboard says so on screen.
 */
export const PLAN_MRR_CENTS: Record<string, number> = {
  starter: 4_900,
  professional: 19_900,
  enterprise: 99_900,
};

/** Statuses that count as money earned — same split the tenant dashboard uses. */
export const REVENUE_STATUSES: readonly string[] = ["PAID", "CLOSED"];

/** Orders still moving through the pipeline. */
export const OPEN_STATUSES: readonly string[] = [
  "DRAFT",
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "INVOICED",
];

/**
 * A suspended tenant contributes nothing, matching the old service. Unknown plans contribute
 * nothing but are still counted as tenants, so a plan name introduced outside this list shows
 * up as a row with zero MRR instead of vanishing from the breakdown.
 */
export function mrrCentsFor(plan: string, isActive: boolean): number {
  if (!isActive) return 0;
  return PLAN_MRR_CENTS[plan] ?? 0;
}

/** UTC day key, `YYYY-MM-DD`. Trend buckets are keyed on this. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The last `days` UTC day keys, oldest first, including today.
 *
 * Pre-seeding every bucket is what the old service's `startOfDaysAgo` loop was for: a chart
 * built only from days that happen to have rows has a discontinuous axis, and a quiet week
 * reads as a shorter month rather than a quiet one.
 */
export function dayKeys(days: number): string[] {
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    keys.push(dayKey(new Date(today - i * 86_400_000)));
  }
  return keys;
}

/** Start of the window the trends and "last 30 days" figures cover. */
export function windowStart(days: number): Date {
  return new Date(Date.parse(`${dayKeys(days)[0]}T00:00:00.000Z`));
}

/** Start of the current calendar month, UTC. */
export function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
