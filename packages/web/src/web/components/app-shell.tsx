import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  Bell,
  Building2,
  ChevronDown,
  Eye,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  ScrollText,
  Search,
  Settings as SettingsIcon,
  ShoppingCart,
  Tags,
  Truck,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "../lib/auth";
import { cn } from "@/lib/utils";
import { MOTHERSHIP_HOME } from "../lib/tenant-path";
import { useLogTenantEntry } from "../queries/activity";
import { useCurrentSession, useInvalidateSession } from "../queries/session";
import { useDashboardStats } from "../queries/dashboard";
import { Input } from "./ui/input";

/**
 * The console chrome from design.md: fixed white 230px sidebar, sticky white top bar, grey
 * page behind borderless white cards.
 *
 * Two things here are deliberately not decoration:
 *   - the sidebar count badges are real numbers from dashboard.stats, not placeholder zeros;
 *   - the bell shows the low-stock count and navigates to /inventory, so it is actionable.
 * Both come from ONE query the shell already needs, gated on role — dashboard.stats is
 * back-office only, so a TENANT_CLIENT would get a FORBIDDEN on every single page load if it
 * were fetched unconditionally.
 *
 * Tenant addressing is never parsed here. Wouter's base already carries any /t/{sub} prefix
 * (see app.tsx), so every href below is written as if the prefix does not exist — which is
 * also what makes real subdomain routing a no-op change at deploy.
 */

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: "products" | "orders" | "lowStock";
  /** Match this href exactly — set on group roots whose children are their own routes. */
  exact?: boolean;
};

const BACK_OFFICE_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/products", label: "Products", icon: Package, badge: "products" },
  { href: "/orders", label: "Orders", icon: ShoppingCart, badge: "orders" },
  { href: "/inventory", label: "Inventory", icon: Warehouse, badge: "lowStock" },
  { href: "/pricing", label: "Pricing", icon: Tags },
  { href: "/shipping", label: "Shipping", icon: Truck },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

/**
 * Buyers get the three surfaces that are theirs. No cart link yet: the cart is filled from the
 * storefront, which arrives with /checkout in phase 6. A link to a page that cannot yet be
 * filled would be a dead end, so the route stays absent rather than stubbed.
 */
const CLIENT_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/products", label: "Catalogue", icon: Package },
  { href: "/orders", label: "My orders", icon: ShoppingCart },
];

/**
 * The mothership group. It is a group INSIDE the same sidebar, not a second shell (design.md):
 * a platform admin who opens a tenant should not feel like they changed applications, and the
 * one thing that must never be ambiguous — which tenant am I looking at — is carried by the
 * banner, not by a different chrome.
 */
const MOTHERSHIP_NAV: NavItem[] = [
  { href: "/admin", label: "Overview", icon: Gauge, exact: true },
  { href: "/admin/tenants", label: "Tenants", icon: Building2 },
  { href: "/admin/activity", label: "Activity", icon: ScrollText },
];

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === "SUPER_ADMIN";
}

export function isBackOfficeRole(role: string | null | undefined): boolean {
  return role === "TENANT_ADMIN" || role === "TENANT_STAFF" || role === "SUPER_ADMIN";
}

/**
 * Admin-only UI gates go through here, never through a literal `role === "TENANT_ADMIN"`.
 *
 * A super admin viewing a tenant keeps the SUPER_ADMIN role (that is what `isViewingAsTenant`
 * is derived from), so any literal comparison to TENANT_ADMIN would show them walls a real
 * tenant admin does not see — and the server would have allowed the write anyway, because
 * `requireRoles` lets a super admin through every gate. Client-side role checks are UX only.
 */
export function isTenantAdminRole(role: string | null | undefined): boolean {
  return role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { data: session } = useCurrentSession();
  const role = session?.user?.role ?? null;
  const backOffice = isBackOfficeRole(role);
  const superAdmin = isSuperAdminRole(role);

  /**
   * A platform admin standing on /admin has NO tenant, and every tenant surface in this chrome
   * — the nav, the product search, the low-stock bell — is meaningless without one.
   * `dashboard.stats` in particular calls `requireTenantId` and answers BAD_REQUEST, so an
   * ungated query here would make every mothership page load a failed request. This is
   * crash-avoidance, not tidiness.
   */
  const hasTenant = Boolean(session?.tenant);
  const { data: stats } = useDashboardStats({ enabled: backOffice && hasTenant });

  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");

  const navItems = hasTenant ? (backOffice ? BACK_OFFICE_NAV : CLIENT_NAV) : [];
  const lowStock = stats?.products.lowStock ?? 0;

  const badgeFor = (item: NavItem): number | null => {
    if (!item.badge || !stats) return null;
    const value =
      item.badge === "products"
        ? stats.products.active
        : item.badge === "orders"
          ? stats.orders.open
          : stats.products.lowStock;
    return value > 0 ? value : null;
  };

  function onSearchSubmit(event: React.FormEvent) {
    event.preventDefault();
    const term = search.trim();
    navigate(term ? `/products?q=${encodeURIComponent(term)}` : "/products");
    setMobileOpen(false);
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile scrim */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[230px] flex-col bg-sidebar shadow-[0_1px_3px_rgb(0_0_0/0.06)] transition-transform lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2 px-5">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-[12px] font-semibold text-primary-foreground">
            B2
          </div>
          <span className="truncate text-[15px] font-semibold text-foreground">
            {session?.tenant?.name ?? "B2B Platform"}
          </span>
          <button
            type="button"
            aria-label="Close navigation"
            className="ml-auto text-muted-foreground lg:hidden"
            onClick={() => setMobileOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {navItems.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              location={location}
              badge={badgeFor(item)}
              onNavigate={() => setMobileOpen(false)}
            />
          ))}

          {superAdmin ? (
            <>
              {navItems.length > 0 ? <div className="mx-5 my-2 h-px bg-border" /> : null}
              <p className="px-5 pt-1 pb-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/70 uppercase">
                Platform
              </p>
              {MOTHERSHIP_NAV.map((item) => (
                <NavRow
                  key={item.href}
                  item={item}
                  location={location}
                  badge={null}
                  onNavigate={() => setMobileOpen(false)}
                />
              ))}
            </>
          ) : null}
        </nav>

        <div className="px-5 py-4 text-[11px] text-muted-foreground">
          {session?.tenant?.subdomain ? <span>{session.tenant.subdomain}</span> : null}
        </div>
      </aside>

      <div className="lg:pl-[230px]">
        <ViewingAsBanner />

        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 bg-card px-4 shadow-[0_1px_3px_rgb(0_0_0/0.06)] lg:px-6">
          <button
            type="button"
            aria-label="Open navigation"
            className="text-muted-foreground lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" />
          </button>

          {hasTenant ? (
            <form onSubmit={onSearchSubmit} className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search products…"
                aria-label="Search products"
                className="rounded-full bg-muted pl-9"
              />
            </form>
          ) : (
            <span className="text-[13px] font-medium text-muted-foreground">Platform console</span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {backOffice && hasTenant ? (
              <button
                type="button"
                aria-label={lowStock > 0 ? `${lowStock} products below MOQ` : "No stock warnings"}
                onClick={() => navigate("/inventory")}
                className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Bell className="size-[18px]" />
                {lowStock > 0 ? (
                  <span className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white tabular-nums">
                    {lowStock > 9 ? "9+" : lowStock}
                  </span>
                ) : null}
              </button>
            ) : null}

            <AccountMenu />
          </div>
        </header>

        <main className="px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function NavRow({
  item,
  location,
  badge,
  onNavigate,
}: {
  item: NavItem;
  location: string;
  badge: number | null;
  onNavigate: () => void;
}) {
  // `/admin` is a group root whose children are separate routes, so a prefix match would leave
  // Overview lit while standing on Tenants. Everything else wants the prefix, because
  // /admin/tenants/{id} should keep Tenants lit.
  const active = item.exact ? location === item.href : location === item.href || location.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-3 border-l-[3px] px-5 py-2.5 text-[13px] transition-colors",
        active
          ? "border-primary font-medium text-primary"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <item.icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{item.label}</span>
      {badge !== null ? (
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            item.badge === "lowStock" ? "bg-destructive text-white" : "bg-accent text-primary",
          )}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * "Viewing as {tenant}" — the whole of what "open as tenant" is.
 *
 * There is no impersonation state anywhere: no session flag, no repointed user row, nothing to
 * get stuck in. A platform admin addressing a tenant URL simply *is* addressing it, and the
 * server derives `isViewingAsTenant` from that request alone (super admin + a resolved tenant).
 * Two tabs can therefore sit on two different tenants without fighting, and closing the tab is
 * a complete exit.
 *
 * Two details that are load-bearing rather than cosmetic:
 *   - Exit is a plain <a>, never a wouter <Link>. The router's base is computed once at mount
 *     from the pathname, so a client-side hop from /t/{sub}/… to /admin would resolve against
 *     the tenant base and land on /t/{sub}/admin. A full navigation recomputes the base.
 *   - The entry log fires once per tenant per page load, gated BOTH client and server side.
 *     The server's 30-minute dedupe is a read-then-write with no atomicity, so it only
 *     collapses *sequential* calls (a reload, a later visit). StrictMode double-invokes this
 *     effect in the same tick, and both calls read an empty window before either insert
 *     commits — which duplicated the audit row in testing. The module-level gate below is
 *     what makes the double-mount harmless; the server window still covers reloads.
 */

/**
 * Tenant ids already logged in this page load. Module-level, matching ManagedAuthGate: a ref
 * would reset with the component, and StrictMode remounts it.
 */
const loggedTenantEntries = new Set<string>();

function ViewingAsBanner() {
  const { data: session } = useCurrentSession();
  const logEntry = useLogTenantEntry();
  const viewing = session?.isViewingAsTenant ? (session.viewingTenant ?? null) : null;
  const viewingId = viewing?.id ?? null;

  const logMutate = logEntry.mutate;
  useEffect(() => {
    if (!viewingId || loggedTenantEntries.has(viewingId)) return;
    loggedTenantEntries.add(viewingId);
    // Fire and forget: an audit write must never block or break the page it is recording.
    logMutate({}, { onError: () => undefined });
  }, [viewingId, logMutate]);

  if (!viewing) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-primary px-4 py-2 text-[13px] text-white lg:px-6">
      <Eye className="size-4 shrink-0 opacity-90" strokeWidth={1.75} />
      <span>
        Viewing as <strong className="font-semibold">{viewing.name}</strong>
        <span className="text-white/75"> · {viewing.subdomain}</span>
      </span>
      <span className="text-white/70">Actions you take here are recorded in this tenant&apos;s activity log.</span>
      <a
        href={MOTHERSHIP_HOME}
        className="ml-auto rounded-full bg-white/15 px-3 py-1 font-medium text-white transition-colors hover:bg-white/25"
      >
        Exit to platform
      </a>
    </div>
  );
}

function AccountMenu() {
  const [, navigate] = useLocation();
  const { data: session } = useCurrentSession();
  const invalidateSession = useInvalidateSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // A plain button plus a panel — no dropdown library is installed and this needs no focus
  // trap. Closing on an outside click is the one behaviour worth wiring by hand.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const email = session?.user?.email ?? "";
  const initial = email.slice(0, 1).toUpperCase() || "?";

  async function onSignOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
      await invalidateSession();
      navigate("/sign-in");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
          {initial}
        </span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-60 rounded-md bg-card p-1 shadow-[0_4px_16px_rgb(0_0_0/0.12)]">
          <div className="px-3 py-2">
            <p className="truncate text-[13px] font-medium text-foreground">{email || "Signed in"}</p>
            <p className="text-[11px] text-muted-foreground">
              {(session?.user?.role ?? "—").replace("_", " ")}
              {session?.tenant?.name ? ` · ${session.tenant.name}` : ""}
            </p>
          </div>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <LogOut className="size-4 text-muted-foreground" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
