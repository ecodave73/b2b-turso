import { createAuthClient } from "better-auth/react";
import { managedAuthClient } from "@runablehq/managed-auth/client";

// Both values are injected into the root .env and exposed to the browser by Vite.
// `issuer` is required — there is no default broker.
const config = {
  applicationId: import.meta.env.VITE_APPLICATION_ID,
  issuer: import.meta.env.VITE_RUNABLE_AUTH_ISSUER,
};

export const authClient = createAuthClient({
  // Packaged desktop builds load from file://, so the page origin is not the server there.
  baseURL: import.meta.env.VITE_WEBSITE_URL ?? window.location.origin,
  basePath: "/api/auth",
  plugins: [managedAuthClient(config)],
});

/**
 * The session user carries the two fields this product routes on: `role` and `tenantId`.
 * Both are declared `input: false` on the server (src/api/auth.ts) — a client-writable
 * `role` would be one-line privilege escalation — so they are readable here but can never
 * be set from the browser.
 */
export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role?: string | null;
  tenantId?: string | null;
}

export function useSession() {
  return authClient.useSession();
}
