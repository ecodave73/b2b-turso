import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { AuthError, AuthShell } from "../components/auth-shell";
import { authClient } from "../lib/auth";
import { useInvalidateSession } from "../queries/session";

export default function SignIn() {
  const [, navigate] = useLocation();
  const invalidateSession = useInvalidateSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"email" | "google" | null>(null);

  async function afterSignIn() {
    await invalidateSession();
    navigate("/dashboard");
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("email");
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setPending(null);
    if (signInError) {
      setError(signInError.message ?? "Could not sign in with those details.");
      return;
    }
    await afterSignIn();
  }

  async function onGoogle() {
    setError(null);
    setPending("google");
    const result = await authClient.managedAuth.signIn({ provider: "google" });
    setPending(null);
    // POPUP_CLOSED means the user dismissed the popup — not a failure worth shouting about.
    if (result.error) {
      if (result.error.code !== "POPUP_CLOSED") setError(result.error.message ?? "Google sign-in failed.");
      return;
    }
    await afterSignIn();
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Access your catalogue, orders and stock."
      footer={
        <>
          No account yet?{" "}
          <Link href="/sign-up" className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <AuthError message={error} />

      <Button variant="outline" className="w-full" onClick={onGoogle} disabled={pending !== null}>
        {pending === "google" ? "Opening Google…" : "Continue with Google"}
      </Button>

      <div className="my-5 flex items-center gap-3 text-[11px] tracking-wide text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        <Button type="submit" className="w-full" disabled={pending !== null}>
          {pending === "email" ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}
