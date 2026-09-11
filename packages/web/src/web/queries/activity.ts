import { useMutation, useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export interface ActivityFilters {
  action?: string;
  limit?: number;
  offset?: number;
}

/** Back-office only on the server — buyers do not read the tenant's audit trail. */
export function useActivityLog(filters: ActivityFilters = {}) {
  return useQuery({
    ...orpc.activity.list.queryOptions({ input: filters }),
    staleTime: 10_000,
    retry: false,
  });
}

/** The action strings this tenant has actually recorded — the filter never goes stale. */
export function useActivityActions() {
  return useQuery({ ...orpc.activity.actions.queryOptions(), staleTime: 60_000, retry: false });
}

/**
 * Records that a platform admin opened this tenant's workspace. Lives here rather than in
 * queries/platform.ts because the procedure lives on the `activity` router — the entry is
 * written into the *customer's* own audit trail, which is the whole point of it.
 *
 * Fire-and-forget: it no-ops on the server for anyone who is not viewing as a tenant, and
 * dedupes on a 30-minute window, so the caller needs no gate of its own and a failure must
 * never block the page. Deliberately does not invalidate the tenant's activity query — the
 * admin has just arrived, and a refetch on mount would be churn for a row they did not come
 * to read.
 */
export function useLogTenantEntry() {
  return useMutation({ ...orpc.activity.logTenantEntry.mutationOptions(), retry: false });
}
