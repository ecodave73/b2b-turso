import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * On-hand stock is derived from the event log, never stored — so recording an event changes
 * every number that mentions stock: the product list's stock column, the dashboard's low-stock
 * count, and this product's own history.
 */
export function useStockHistory(productId: string | null, limit = 20) {
  return useQuery({
    ...orpc.inventory.history.queryOptions({ input: { productId: productId ?? "", limit } }),
    enabled: !!productId,
  });
}

export function useRecordInventoryEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.inventory.record.mutationOptions(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.inventory.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.catalog.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.activity.key() }),
      ]);
    },
  });
}
