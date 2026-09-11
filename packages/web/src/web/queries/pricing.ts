import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function usePriceTiers(productId: string | null) {
  return useQuery({
    ...orpc.pricing.tiers.queryOptions({ input: { productId: productId ?? "" } }),
    enabled: !!productId,
  });
}

/**
 * The same function the cart and order creation price with, so the number shown here is the
 * number that will be charged. It fails loudly below MOQ (BAD_REQUEST) — that is a real answer
 * to "what does 5 cost?", not an error to hide, so retries are off and the message is shown.
 */
export function usePriceQuote(productId: string | null, quantity: number) {
  return useQuery({
    ...orpc.pricing.quote.queryOptions({ input: { productId: productId ?? "", quantity } }),
    enabled: !!productId && Number.isInteger(quantity) && quantity > 0,
    retry: false,
  });
}

function usePricingInvalidation() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.pricing.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.catalog.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.activity.key() }),
    ]);
  };
}

export function useCreatePriceTier() {
  const invalidate = usePricingInvalidation();
  return useMutation({ ...orpc.pricing.createTier.mutationOptions(), onSuccess: invalidate });
}

export function useDeletePriceTier() {
  const invalidate = usePricingInvalidation();
  return useMutation({ ...orpc.pricing.deleteTier.mutationOptions(), onSuccess: invalidate });
}
