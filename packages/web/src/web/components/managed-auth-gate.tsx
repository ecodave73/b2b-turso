import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "../lib/auth";
import { PageLoading } from "./protected-route";

/**
 * Completes a returning managed sign-in before any route renders.
 *
 * WHY THIS IS A COMPONENT AND NOT A TOP-LEVEL AWAIT IN main.tsx:
 * the managed redirect leg lands back on the app with credentials in the URL, and
 * `handleRedirect()` is what turns them into the app's bearer session. The obvious place for
 * that is `main.tsx`, before the bootstrap — but `__main.tsx` is a side-effect module that
 * mounts React the moment it is evaluated, and konsistent requires main.tsx to import it
 * statically. Static imports are hoisted, so the mount would always win the race against a
 * top-level await. Gating inside the tree is the version that actually orders correctly.
 *
 * Without this gate the redirect leg renders routes while the session is still in flight, and
 * ProtectedRoute bounces the user to /sign-in a beat before their credentials land — a sign-in
 * that visibly fails and then works on refresh.
 *
 * It is a no-op for the popup and desktop flows, which resolve their own promise.
 */

/**
 * Module-level so it runs exactly once per page load. StrictMode double-invokes effects in
 * dev, and the redirect credentials are single-use — a second call would consume nothing and
 * reject.
 */
let redirectCompletion: Promise<void> | null = null;

function completeManagedRedirect(): Promise<void> {
  // A failure here means "no credentials to exchange", which is the normal case on every
  // ordinary page load. It must never block the app from rendering.
  redirectCompletion ??= authClient.managedAuth.handleRedirect().then(
    () => undefined,
    () => undefined,
  );
  return redirectCompletion;
}

export function ManagedAuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void completeManagedRedirect().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!ready) return <PageLoading />;

  return <>{children}</>;
}
