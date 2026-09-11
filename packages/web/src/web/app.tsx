import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { ManagedAuthGate } from "./components/managed-auth-gate";
import { Provider } from "./components/provider";
import { ProtectedRoute, SuperAdminRoute } from "./components/protected-route";
import { TENANT_PATH_PREFIX } from "./lib/tenant-path";
import Activity from "./pages/activity";
import AdminActivity from "./pages/admin/activity";
import AdminOverview from "./pages/admin/overview";
import AdminTenantDetail from "./pages/admin/tenant-detail";
import AdminTenants from "./pages/admin/tenants";
import Dashboard from "./pages/dashboard";
import Inventory from "./pages/inventory";
import Orders from "./pages/orders";
import Pricing from "./pages/pricing";
import Products from "./pages/products";
import Settings from "./pages/settings";
import Shipping from "./pages/shipping";
import SignIn from "./pages/sign-in";
import SignUp from "./pages/sign-up";
import Signup from "./pages/signup";
import { AgentFeedback, RunableBadge } from "@runablehq/website-runtime";

/**
 * Tenant addressing in the browser mirrors the server seam (src/api/tenant/resolve.ts):
 * `/t/{subdomain}/dashboard` renders the same tree as `/dashboard`, with the prefix carried
 * as the Wouter base. The typed oRPC client forwards the full pathname to the server on every
 * call, which is how the server sees the prefix at all. When real `{subdomain}.host` routing is
 * switched on at deploy, the base is simply empty and nothing else changes.
 *
 * The prefix itself is owned by src/web/lib/tenant-path.ts, which is also what the mothership
 * uses to build links *into* a tenant. One constant, one place to change at deploy.
 */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function tenantBase(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2 || `/${segments[0]}` !== TENANT_PATH_PREFIX) return "";
  const label = segments[1]!.toLowerCase();
  return SUBDOMAIN_PATTERN.test(label) ? `${TENANT_PATH_PREFIX}/${label}` : "";
}

function Routes() {
  return (
    <Switch>
      <Route path="/sign-in" component={SignIn} />
      <Route path="/sign-up" component={SignUp} />
      {/* Account exists, workspace does not — so this one is gated on auth, not on a tenant. */}
      <Route path="/signup">
        <ProtectedRoute requireTenant={false}>
          <Signup />
        </ProtectedRoute>
      </Route>

      <Route path="/dashboard">
        <ProtectedRoute>
          <Dashboard />
        </ProtectedRoute>
      </Route>

      <Route path="/products">
        <ProtectedRoute>
          <Products />
        </ProtectedRoute>
      </Route>

      <Route path="/orders">
        <ProtectedRoute>
          <Orders />
        </ProtectedRoute>
      </Route>

      <Route path="/inventory">
        <ProtectedRoute>
          <Inventory />
        </ProtectedRoute>
      </Route>

      <Route path="/pricing">
        <ProtectedRoute>
          <Pricing />
        </ProtectedRoute>
      </Route>

      <Route path="/shipping">
        <ProtectedRoute>
          <Shipping />
        </ProtectedRoute>
      </Route>

      <Route path="/activity">
        <ProtectedRoute>
          <Activity />
        </ProtectedRoute>
      </Route>

      <Route path="/settings">
        <ProtectedRoute>
          <Settings />
        </ProtectedRoute>
      </Route>

      {/*
        The mothership. Gated on SuperAdminRoute, not ProtectedRoute: a platform admin has no
        tenant of their own, so `requireTenant` would bounce them to /signup. The parameterised
        route is declared before its parent so the Switch matches the detail page first.
      */}
      <Route path="/admin/tenants/:tenantId">
        <SuperAdminRoute>
          <AdminTenantDetail />
        </SuperAdminRoute>
      </Route>

      <Route path="/admin/tenants">
        <SuperAdminRoute>
          <AdminTenants />
        </SuperAdminRoute>
      </Route>

      <Route path="/admin/activity">
        <SuperAdminRoute>
          <AdminActivity />
        </SuperAdminRoute>
      </Route>

      <Route path="/admin">
        <SuperAdminRoute>
          <AdminOverview />
        </SuperAdminRoute>
      </Route>

      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>

      {/*
        Still absent by design, not stubbed: /checkout, /storefront and /cms-ops land with the
        Sanity storefront in phase 6a. A missing page should be obvious rather than look
        half-built.
      */}
      <Route>
        <NotFound />
      </Route>
    </Switch>
  );
}

function NotFound() {
  const [location] = useLocation();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background px-4 text-center">
      <h1 className="text-[20px] font-semibold text-foreground">Not here yet</h1>
      <p className="max-w-md text-[13px] text-muted-foreground">
        <code>{location}</code> isn&apos;t a page in this build. The storefront and checkout pages
        arrive in a later phase.
      </p>
    </div>
  );
}

function App() {
  const base = tenantBase(window.location.pathname);

  return (
    <Provider>
      <ManagedAuthGate>
        <Router base={base}>
          <Routes />
        </Router>
      </ManagedAuthGate>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
      {/* "Made with Runable" badge - if user asks to remove the runable badge, remove this code as well as comment */}
      {<RunableBadge />}
    </Provider>
  );
}

export default App;
