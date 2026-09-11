import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { AuthError, AuthShell } from "../components/auth-shell";
import { authClient } from "../lib/auth";
import { useCreateTenant, useSubdomainAvailability } from "../queries/signup";
import { useCurrentSession } from "../queries/session";

/**
 * Self-service tenant creation — one of the sixteen routes preserved verbatim from the old
 * app, because tenants have these URLs bookmarked.
 *
 * Billing is phase 6, so there is no plan checkout leg here yet: picking a plan records the
 * choice on the tenant row and nothing charges. The old wizard's Stripe step lands in phase 6.
 */

const PLANS = [
  { id: "starter", name: "Starter", blurb: "One location, up to 250 SKUs." },
  { id: "professional", name: "Professional", blurb: "Volume pricing tiers and multiple staff." },
  { id: "enterprise", name: "Enterprise", blurb: "Custom domain, priority support." },
] as const;

type PlanId = (typeof PLANS)[number]["id"];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function Signup() {
  const [, navigate] = useLocation();
  const { data: authSession, isPending: authPending } = authClient.useSession();
  const { data: current } = useCurrentSession();
  const createTenant = useCreateTenant();

  const [companyName, setCompanyName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  const [plan, setPlan] = useState<PlanId>("starter");
  const [error, setError] = useState<string | null>(null);

  // Debounce before asking the server whether the name is free.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(subdomain), 350);
    return () => clearTimeout(timer);
  }, [subdomain]);
  const availability = useSubdomainAvailability(debounced);

  // Signed out: this page cannot do anything useful. Create the account first.
  useEffect(() => {
    if (!authPending && !authSession) navigate("/sign-up");
  }, [authPending, authSession, navigate]);

  // Already has a tenant — the server would answer CONFLICT, so don't offer the form.
  useEffect(() => {
    if (current?.tenant) navigate("/dashboard");
  }, [current?.tenant, navigate]);

  function onCompanyNameChange(value: string) {
    setCompanyName(value);
    if (!subdomainTouched) setSubdomain(slugify(value));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createTenant.mutateAsync({ companyName: companyName.trim(), subdomain, plan });
      navigate("/dashboard");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not create the workspace.");
    }
  }

  const availabilityMessage = (() => {
    if (subdomain.length < 3) return null;
    if (debounced !== subdomain || availability.isPending) return { tone: "muted", text: "Checking…" } as const;
    if (availability.isError) return { tone: "muted", text: "Could not check that name." } as const;
    if (!availability.data) return null;
    return availability.data.available
      ? ({ tone: "ok", text: `${subdomain} is available.` } as const)
      : ({ tone: "bad", text: availability.data.reason ?? "That name is unavailable." } as const);
  })();

  const canSubmit =
    companyName.trim().length >= 2 && subdomain.length >= 3 && availability.data?.available === true && !createTenant.isPending;

  return (
    <AuthShell
      wide
      title="Set up your workspace"
      subtitle="Your company gets its own subdomain, isolated from every other tenant."
      footer={
        <>
          Wrong account?{" "}
          <Link href="/sign-in" className="font-medium text-primary hover:underline">
            Sign in as someone else
          </Link>
        </>
      }
    >
      <AuthError message={error} />

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="companyName">Company name</Label>
          <Input
            id="companyName"
            required
            minLength={2}
            value={companyName}
            onChange={(e) => onCompanyNameChange(e.target.value)}
            placeholder="Northgate Supply Co."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="subdomain">Subdomain</Label>
          <div className="flex items-center gap-2">
            <Input
              id="subdomain"
              required
              minLength={3}
              value={subdomain}
              onChange={(e) => {
                setSubdomainTouched(true);
                setSubdomain(e.target.value.toLowerCase());
              }}
              placeholder="northgate"
              aria-invalid={availabilityMessage?.tone === "bad"}
            />
            <span className="shrink-0 text-[12px] text-muted-foreground">.example.com</span>
          </div>
          {availabilityMessage ? (
            <p
              className={
                availabilityMessage.tone === "ok"
                  ? "text-[12px] text-[color:var(--success)]"
                  : availabilityMessage.tone === "bad"
                    ? "text-[12px] text-destructive"
                    : "text-[12px] text-muted-foreground"
              }
            >
              {availabilityMessage.text}
            </p>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              Lowercase letters, numbers and hyphens. This is your customers' address.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label>Plan</Label>
          <div className="grid gap-2">
            {PLANS.map((option) => {
              const selected = plan === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setPlan(option.id)}
                  className={`rounded-md border px-4 py-3 text-left transition-colors ${
                    selected ? "border-primary bg-accent" : "border-border bg-card hover:border-primary/40"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-semibold text-foreground">{option.name}</span>
                    <span
                      className={`size-3.5 rounded-full border ${selected ? "border-primary bg-primary" : "border-border"}`}
                    />
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{option.blurb}</p>
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-muted-foreground">
            No card required yet — billing is not wired up, so nothing is charged today.
          </p>
        </div>

        <Button type="submit" className="w-full" disabled={!canSubmit}>
          {createTenant.isPending ? "Creating workspace…" : "Create workspace"}
        </Button>
      </form>
    </AuthShell>
  );
}
