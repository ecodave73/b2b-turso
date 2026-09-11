import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { AuthError, AuthShell } from "../components/auth-shell";
import { authClient } from "../lib/auth";
import { useInvalidateSession } from "../queries/session";

/**
 * Creates the *account*, not the tenant. New accounts land with role TENANT_CLIENT and
 * tenantId null — the server sets both and refuses to let the client write them. Turning
 * that account into a tenant admin happens at /signup, which is the next stop here.
 */
export default function SignUp() {
  const [, navigate] = useLocation();
  const invalidateSession = useInvalidateSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"email" | "google" | null>(null);

  async function afterSignUp() {
    await invalidateSession();
    navigate("/signup");
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("email");
    const { error: signUpError } = await authClient.signUp.email({ email, password, name });
    setPending(null);
    if (signUpError) {
      setError(signUpError.message ?? "Could not create that account.");
      return;
    }
    await afterSignUp();
  }

  async function onGoogle() {
    setError(null);
    setPending("google");
    const result = await authClient.managedAuth.signIn({ provider: "google" });
    setPending(null);
    if (result.error) {
      if (result.error.code !== "POPUP_CLOSED") setError(result.error.message ?? "Google sign-up failed.");
      return;
    }
    await afterSignUp();
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Then set up your company workspace."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-primary hover:underline">
            Sign in
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
          <Label htmlFor="name">Your name</Label>
          <Input
            id="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex Turner"
          />
        </div>

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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
        </div>

        <Button type="submit" className="w-full" disabled={pending !== null}>
          {pending === "email" ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}
