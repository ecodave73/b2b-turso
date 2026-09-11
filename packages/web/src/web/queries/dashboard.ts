import { useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * Dashboard aggregates. BOTH procedures are back-office only (tenantStaff on the server), so
 * every call site must pass `enabled` for the signed-in role — an unconditional query would
 * throw FORBIDDEN on every page load for a TENANT_CLIENT, including in the app shell, whose
 * sidebar counts come from here.
 */
export function useDashboardStats(options?: { enabled?: boolean }) {
  return useQuery({
    ...orpc.dashboard.stats.queryOptions(),
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
    // A role refusal is not a transient failure; retrying it three times just delays the UI.
    retry: false,
  });
}

export function useLowStock(limit = 10, options?: { enabled?: boolean }) {
  return useQuery({
    ...orpc.dashboard.lowStock.queryOptions({ input: { limit } }),
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
    retry: false,
  });
}
