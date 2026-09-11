import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export interface OrderFilters {
  status?:
    | "DRAFT"
    | "PENDING"
    | "CONFIRMED"
    | "SHIPPED"
    | "INVOICED"
    | "PAID"
    | "CLOSED"
    | "CANCELLED";
  limit?: number;
  offset?: number;
}

export function useOrders(filters: OrderFilters = {}) {
  return useQuery({ ...orpc.orders.list.queryOptions({ input: filters }), staleTime: 10_000 });
}

export function useOrder(id: string | null) {
  return useQuery({
    ...orpc.orders.get.queryOptions({ input: { id: id ?? "" } }),
    enabled: !!id,
  });
}

export function useCompanies() {
  return useQuery({ ...orpc.orders.listCompanies.queryOptions(), staleTime: 60_000 });
}

/**
 * A status change is refused by the server unless it follows a legal edge of the state machine
 * (api/services/orders.ts). The UI only offers legal targets, but the server is what decides —
 * the mutation error is surfaced rather than swallowed.
 */
export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.orders.updateStatus.mutationOptions(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.activity.key() }),
      ]);
    },
  });
}
