import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { auth } from "./auth";
import { activity } from "./routes/activity";
import { cart } from "./routes/cart";
import { catalog } from "./routes/catalog";
import { dashboard } from "./routes/dashboard";
import { inventory } from "./routes/inventory";
import { orders } from "./routes/orders";
import { ping } from "./routes/ping";
import { platform } from "./routes/platform";
import { pricing } from "./routes/pricing";
import { session } from "./routes/session";
import { settings } from "./routes/settings";
import { shipping } from "./routes/shipping";
import { signup } from "./routes/signup";

// API features are oRPC procedures, one file per feature in ./routes/,
// composed into this router — typed end-to-end via the clients
// (web: src/web/lib/api.ts, mobile: lib/api.ts).
// Keep each routes/ file under 500 lines (`bun run lint` enforces this);
// split into more feature files as they grow.
// Patterns and examples: skills/app/references/api.md
export const router = {
  ping,
  session,
  signup,
  catalog,
  inventory,
  pricing,
  orders,
  cart,
  shipping,
  dashboard,
  activity,
  settings,
  platform,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);
// Rare plain-HTTP endpoints (webhooks, streaming, the Better Auth handler)
// register here with full paths, e.g. app.post("/api/webhooks/example", ...)

// Better Auth owns everything under /api/auth (sign-in, sign-up, session, the managed
// OAuth exchange). It is not an oRPC procedure — it speaks its own HTTP protocol.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

export default app;
