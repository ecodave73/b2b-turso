import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "../../api";
import { authClient } from "./auth";

const link = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
  headers: () => {
    const headers: Record<string, string> = {
      // Every oRPC call goes to /api/rpc/..., so the server can never see /t/acme/dashboard
      // on its own. The tenant-resolution seam (src/api/tenant/resolve.ts) reads the browser
      // path from this header; without it, path-prefix tenant addressing is dead in the
      // browser. It grants nothing: an authenticated non-super-admin's effective tenant
      // always comes from their own user row.
      "x-tenant-path": window.location.pathname,
    };
    const token = authClient.managedAuth.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  },
});

/** Direct typed client: await client.ping() */
export const client: AppRouterClient = createORPCClient(link);

/** TanStack Query helpers: useQuery(orpc.ping.queryOptions()) */
export const orpc = createTanstackQueryUtils(client);
