import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export function useTenantSettings(options?: { enabled?: boolean }) {
  return useQuery({
    ...orpc.settings.get.queryOptions(),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * TENANT_ADMIN only on the server. The tenant name is rendered in the app shell from the
 * session, so a successful rename has to invalidate that too or the sidebar keeps the old one
 * until the next reload.
 */
export function useUpdateTenantSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.settings.update.mutationOptions(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.settings.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.session.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.activity.key() }),
      ]);
    },
  });
}
