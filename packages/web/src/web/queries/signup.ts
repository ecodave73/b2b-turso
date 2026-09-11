import { useMutation, useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import { useInvalidateSession } from "./session";

/**
 * Live subdomain availability for the registration form. Pass an already-debounced value —
 * this fires one request per distinct value and caches the answer.
 *
 * It is only ever advisory: `createTenant` re-checks through the same server-side helper,
 * so a name taken between the check and the submit fails there, not silently.
 */
export function useSubdomainAvailability(subdomain: string) {
  return useQuery({
    ...orpc.signup.checkSubdomain.queryOptions({ input: { subdomain } }),
    enabled: subdomain.length >= 3,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Create a tenant and become its TENANT_ADMIN. The caller's own user row changes as part
 * of this, so the cached session is stale the moment it succeeds.
 */
export function useCreateTenant() {
  const invalidateSession = useInvalidateSession();
  return useMutation({
    ...orpc.signup.createTenant.mutationOptions(),
    onSuccess: () => invalidateSession(),
  });
}
