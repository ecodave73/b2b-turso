import { expo } from "@better-auth/expo";
import { runableManagedAuth } from "@runablehq/managed-auth/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./database";
import * as authSchema from "./database/auth-schema";
import * as schema from "./database/schema";

/**
 * Better Auth owns the `users` table as its `user` model — there is no second profile table.
 * The ported columns (`tenantId`, `role`, `handle`, `phone`) live on that same row, which is
 * what lets the tenant guard's `userScope` govern it with no join.
 *
 * WHY THIS FILE IMPORTS THE RAW CLIENT (and is allowlisted in tenant/verify-guard.ts):
 * Better Auth writes the user row at signup, before the caller belongs to any tenant, and it
 * manages `session`/`account`/`verification`, which are not tenant-scoped at all. It cannot go
 * through `scopedDb`. This is a deliberate, narrow hole: auth may create and read a user row,
 * and nothing else in the app may touch the raw client.
 *
 * `role` and `tenantId` are exposed on the session user as `input: false` — readable by the
 * client, never writable by it. A client-writable `role` would be a one-line privilege
 * escalation, which is exactly the hole the phase-1 guard hardening closed on the DB side.
 */
export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env.WEBSITE_URL,
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: {
      ...schema,
      ...authSchema,
      user: schema.users,
    },
  }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET,
  user: {
    modelName: "user",
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "TENANT_CLIENT", input: false },
      tenantId: { type: "string", required: false, input: false },
      handle: { type: "string", required: false, input: false },
      phone: { type: "string", required: false, input: true },
    },
  },
  trustedOrigins: (request) => {
    const origin = request?.headers.get("origin");
    return origin ? [origin] : ["*"];
  },
  plugins: [
    ...runableManagedAuth({
      applicationId: process.env.APPLICATION_ID!,
      issuer: process.env.VITE_RUNABLE_AUTH_ISSUER!,
    }),
    expo(),
  ],
});
