import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * The tenant's own rate table. There is no live carrier integration — `shipping.rates` tags
 * every row `isLive: false` and the page says so out loud, because a quote that looks live but
 * is a hand-typed fallback is worse than no quote at all.
 */
export function useShippingRates() {
  return useQuery({ ...orpc.shipping.list.queryOptions(), staleTime: 30_000 });
}

function useShippingInvalidation() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.shipping.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.activity.key() }),
    ]);
  };
}

export function useCreateShippingRate() {
  const invalidate = useShippingInvalidation();
  return useMutation({ ...orpc.shipping.create.mutationOptions(), onSuccess: invalidate });
}

export function useDeleteShippingRate() {
  const invalidate = useShippingInvalidation();
  return useMutation({ ...orpc.shipping.delete.mutationOptions(), onSuccess: invalidate });
}
