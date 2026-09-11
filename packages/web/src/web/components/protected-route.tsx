import type { ReactNode } from "react";
import { Link, Redirect } from "wouter";
import { useCurrentSession } from "../queries/session";

/**
 * Client-side gating only — it decides what to *render*, never what a caller may read.
 * Every procedure enforces its own role base on the server (src/api/middleware/auth.ts),
 * and the tenant guard isolates rows underneath that. Removing this component would hide
 * no data; it would just show an empty page to someone who has no business seeing it.
 *
 * The signed-in test reads `session.current` — the server's answer — and deliberately not
 * Better Auth's `useSession()` store. That store is a client-side cache refreshed on its
 * own schedule: immediately after sign-in or sign-up it can still hold `null` with
 * `isPending` already false, which this component used to read as "signed out" and bounce
 * a freshly authenticated user to /sign-in. One authority avoids that race entirely, and
 * the queries invalidate `session.current` on sign-in, sign-up, sign-out and tenant
 * creation, so it is never stale when identity changes.
 */
export function ProtectedRoute({ children, requireTenant = true }: { children: ReactNode; requireTenant?: boolean }) {
  const { data: current, isPending, error } = useCurrentSession();

  if (isPending) return <PageLoading />;
  // A tenant suspended underneath a signed-in member makes this call fail. Saying so beats
  // redirecting to /sign-in, which would just bounce back here forever.
  if (error) return <SessionUnavailable message={error.message} />;
  if (!current?.user) return <Redirect to="/sign-in" />;

  // Signed in with no tenant yet — the account exists but the workspace does not. A platform
  // admin is the one identity that legitimately never owns a tenant, so sending them to the
  // "create your workspace" form is wrong; the mothership is their home. They still render
  // tenant pages normally while viewing as a tenant, because then `current.tenant` is set.
  if (requireTenant && !current.tenant) {
    return <Redirect to={current.user.role === "SUPER_ADMIN" ? "/admin" : "/signup"} />;
  }

  return <>{children}</>;
}

/** SUPER_ADMIN-only surfaces (the mothership, phase 5). */
export function SuperAdminRoute({ children }: { children: ReactNode }) {
  const { data: current, isPending, error } = useCurrentSession();

  if (isPending) return <PageLoading />;
  if (error) return <SessionUnavailable message={error.message} />;
  if (!current?.user) return <Redirect to="/sign-in" />;
  if (current.user.role !== "SUPER_ADMIN") return <Redirect to="/dashboard" />;

  return <>{children}</>;
}

export function PageLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <span className="text-[13px] text-muted-foreground">Loading…</span>
    </div>
  );
}

function SessionUnavailable({ message }: { message?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background px-4 text-center">
      <h1 className="text-[20px] font-semibold text-foreground">We couldn&apos;t load your workspace</h1>
      <p className="max-w-md text-[13px] text-muted-foreground">
        {message ?? "Something went wrong reading your session."}
      </p>
      <Link href="/sign-in" className="mt-2 text-[13px] font-medium text-primary hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}
