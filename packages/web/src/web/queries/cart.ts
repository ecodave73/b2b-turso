import { useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/**
 * The buyer's own cart. Open to any authenticated tenant user, which is why the client
 * dashboard is built from this plus `orders.list` rather than from `dashboard.stats` — the
 * latter is back-office only and would 403 for a buyer.
 *
 * The cart UI itself (and /checkout) lands in phase 6 with the Sanity storefront, since a
 * cart is filled from the storefront. This hook exists so the buyer's dashboard can show what
 * is already waiting in it.
 */
export function useCartSummary(options?: { enabled?: boolean }) {
  return useQuery({
    ...orpc.cart.summary.queryOptions({ input: {} }),
    enabled: options?.enabled ?? true,
    staleTime: 10_000,
    retry: false,
  });
}
