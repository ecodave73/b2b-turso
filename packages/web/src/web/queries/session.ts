import { useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * `session.current` is the one call the shell makes on every page load: who am I, and
 * which tenant is this request addressing. It answers for anonymous visitors too, so it
 * is never gated on a signed-in state — a storefront visitor gets the tenant with a null
 * user, and the signed-out dashboard learns it is signed out without interpreting a 401.
 */
export function useCurrentSession() {
  return useQuery({
    ...orpc.session.current.queryOptions(),
    // Identity and tenant change on sign-in/out and on tenant creation, all of which
    // invalidate explicitly. Refetching on every window focus just adds noise.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** Call after sign-in, sign-out or tenant creation — identity has changed underneath us. */
export function useInvalidateSession() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.session.current.key() });
}
