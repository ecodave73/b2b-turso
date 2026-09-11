import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export interface ProductFilters {
  search?: string;
  categoryId?: string;
  isActive?: boolean;
  withStock?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * SEARCH IS A LIKE FILTER, not full text — the Postgres tsvector column was dropped in the
 * port and FTS5 lands in phase 6. Results come back newest first, never best-match first, so
 * nothing built on this hook may present them as ranked.
 */
export function useProducts(filters: ProductFilters = {}) {
  return useQuery({
    ...orpc.catalog.list.queryOptions({ input: filters }),
    staleTime: 10_000,
  });
}

export function useProduct(id: string | null) {
  return useQuery({
    ...orpc.catalog.get.queryOptions({ input: { id: id ?? "" } }),
    enabled: !!id,
  });
}

export function useCategories() {
  return useQuery({ ...orpc.catalog.listCategories.queryOptions(), staleTime: 60_000 });
}

/** Product writes move stock-independent dashboard counts, so both caches are invalidated. */
function useCatalogInvalidation() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.catalog.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.activity.key() }),
    ]);
  };
}

export function useCreateProduct() {
  const invalidate = useCatalogInvalidation();
  return useMutation({ ...orpc.catalog.create.mutationOptions(), onSuccess: invalidate });
}

export function useUpdateProduct() {
  const invalidate = useCatalogInvalidation();
  return useMutation({ ...orpc.catalog.update.mutationOptions(), onSuccess: invalidate });
}

/** Archive, not delete: historical orders reference products, so rows are never removed. */
export function useArchiveProduct() {
  const invalidate = useCatalogInvalidation();
  return useMutation({ ...orpc.catalog.archive.mutationOptions(), onSuccess: invalidate });
}

export function useCreateCategory() {
  const invalidate = useCatalogInvalidation();
  return useMutation({ ...orpc.catalog.createCategory.mutationOptions(), onSuccess: invalidate });
}
