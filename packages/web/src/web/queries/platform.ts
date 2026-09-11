import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * The mothership's reads. Every procedure here sits on the `superAdmin` base, so a refusal is
 * a role decision, not a transient failure — `retry: false` everywhere, exactly as the
 * back-office hooks do. Nothing on these pages is gated on the caller having a tenant: a
 * platform admin normally has none.
 *
 * These aggregates scan every tenant's rows and fold them in TypeScript. That is correct and
 * isolated, but it is O(all rows on the platform) per call, so the stale times here are longer
 * than the tenant dashboard's and none of them refetch on focus.
 */
export interface PlatformTenantFilters {
  search?: string;
  plan?: "starter" | "professional" | "enterprise";
  status?: "active" | "suspended" | "all";
  includeSandbox?: boolean;
  limit?: number;
  offset?: number;
}

export interface PlatformActivityFilters {
  tenantId?: string;
  entity?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function usePlatformStats() {
  return useQuery({
    ...orpc.platform.stats.queryOptions(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function usePlatformTenants(filters: PlatformTenantFilters = {}) {
  return useQuery({
    ...orpc.platform.tenants.queryOptions({ input: filters }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useTenantDetail(tenantId: string) {
  return useQuery({
    ...orpc.platform.tenantDetail.queryOptions({ input: { tenantId } }),
    enabled: tenantId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function usePlatformActivity(filters: PlatformActivityFilters = {}) {
  return useQuery({
    ...orpc.platform.activity.queryOptions({ input: filters }),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Suspension is an ops switch, never a billing one — it drops the tenant out of MRR and stops
 * its storefront serving, so the tenant list, the detail page and the platform aggregates all
 * go stale the moment it flips. Invalidating the whole `platform` key is cheaper to reason
 * about than naming three of its children, and this mutation is rare by definition.
 */
export function useSetTenantActive() {
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.platform.setTenantActive.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.platform.key() });
    },
  });
}

/** Moves the platform record and the MRR figure only. Stripe is phase 6b. */
export function useUpdateTenantPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.platform.updateTenantPlan.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.platform.key() });
    },
  });
}
