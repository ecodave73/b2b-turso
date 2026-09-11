import { useEffect, useState } from "react";
import { CreditCard, Lock, Settings2 } from "lucide-react";
import { AppShell, isBackOfficeRole, isTenantAdminRole } from "../components/app-shell";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { formatDate } from "../lib/format";
import { useCurrentSession } from "../queries/session";
import { useTenantSettings, useUpdateTenantSettings } from "../queries/settings";

/**
 * Workspace settings — the tenant-profile half of the old 505-line page.
 *
 * What is deliberately read-only here, and why:
 *   · subdomain / custom domain — tenant addressing is wired at deploy through the resolver
 *     seam; renaming mid-flight would strand every URL already in circulation.
 *   · plan and billing — phase 6, on the real Stripe SDK. A tenant writing its own plan column
 *     is not a subscription.
 *   · active / sandbox — a support switch, never self-service.
 *
 * Editing is TENANT_ADMIN only. Staff read; the server is what refuses a write.
 */
export default function Settings() {
  const { data: session } = useCurrentSession();
  const role = session?.user?.role;
  const backOffice = isBackOfficeRole(role);
  const canEdit = isTenantAdminRole(role);

  const { data: settings, isPending, error } = useTenantSettings({ enabled: backOffice });

  if (!backOffice) {
    return (
      <AppShell>
        <PageHeader title="Settings" />
        <Card>
          <CardContent>
            <EmptyState
              icon={Lock}
              title="Back-office only"
              description="Workspace settings are visible to administrators and staff."
            />
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Settings"
        description="Your workspace's name and branding. Addressing, plan and billing are managed elsewhere."
      />

      {error ? (
        <Card>
          <CardContent className="text-[13px] text-destructive">{error.message}</CardContent>
        </Card>
      ) : isPending || !settings ? (
        <Card>
          <CardContent className="text-[13px] text-muted-foreground">Loading settings…</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <ProfileCard settings={settings} canEdit={canEdit} />

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Workspace</CardTitle>
                <CardDescription>Set when the workspace was created; changed by support.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 pt-4 text-[13px]">
                <ReadOnlyRow label="Subdomain" value={settings.subdomain} />
                <ReadOnlyRow label="Custom domain" value={settings.customDomain ?? "Not configured"} />
                <ReadOnlyRow label="Domain status" value={settings.domainStatus ?? "—"} />
                <ReadOnlyRow label="Plan" value={settings.plan} />
                <ReadOnlyRow
                  label="State"
                  value={
                    settings.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="destructive">Suspended</Badge>
                    )
                  }
                />
                <ReadOnlyRow
                  label="Mode"
                  value={settings.isSandbox ? <Badge variant="warning">Sandbox</Badge> : "Live"}
                />
                <ReadOnlyRow label="Created" value={formatDate(settings.createdAt)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Billing</CardTitle>
                <CardDescription>Subscriptions arrive with the storefront.</CardDescription>
              </CardHeader>
              <CardContent className="pt-4">
                <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
                  <CreditCard className="mt-0.5 size-4 shrink-0" />
                  {settings.billingConnected
                    ? "A Stripe subscription is on file for this workspace."
                    : "No payment method is connected. Nothing is being charged, and the plan above is a label only until billing is wired up."}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function ProfileCard({
  settings,
  canEdit,
}: {
  settings: { name: string; logo: string | null; brandColor: string };
  canEdit: boolean;
}) {
  const update = useUpdateTenantSettings();

  const [name, setName] = useState(settings.name);
  const [logo, setLogo] = useState(settings.logo ?? "");
  const [brandColor, setBrandColor] = useState(settings.brandColor);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A rename invalidates the settings query; re-seed the fields from whatever came back.
  useEffect(() => {
    setName(settings.name);
    setLogo(settings.logo ?? "");
    setBrandColor(settings.brandColor);
  }, [settings.name, settings.logo, settings.brandColor]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError(null);
    setSaved(false);

    if (!name.trim()) {
      setValidationError("The workspace needs a name.");
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(brandColor.trim())) {
      setValidationError("Brand colour must be a 6-digit hex value like #2260F6.");
      return;
    }

    try {
      await update.mutateAsync({
        name: name.trim(),
        logo: logo.trim() || null,
        brandColor: brandColor.trim(),
      });
      setSaved(true);
    } catch {
      // Surfaced below from the mutation's error state.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          The brand colour themes your storefront. The dashboard keeps its own palette so the
          console reads the same whichever workspace you are in.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tenantName">Workspace name</Label>
            <Input
              id="tenantName"
              value={name}
              disabled={!canEdit}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tenantLogo">Logo URL</Label>
            <Input
              id="tenantLogo"
              value={logo}
              disabled={!canEdit}
              onChange={(event) => setLogo(event.target.value)}
              placeholder="https://…"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brandColorHex">Brand colour</Label>
            <div className="flex items-center gap-2">
              <input
                id="brandColorPicker"
                type="color"
                aria-label="Pick a brand colour"
                value={/^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#1a1a2e"}
                disabled={!canEdit}
                onChange={(event) => setBrandColor(event.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border border-input bg-card p-1 disabled:pointer-events-none disabled:opacity-50"
              />
              <Input
                id="brandColorHex"
                value={brandColor}
                disabled={!canEdit}
                onChange={(event) => setBrandColor(event.target.value)}
                placeholder="#2260F6"
                className="max-w-[160px]"
              />
            </div>
          </div>

          {validationError || update.error ? (
            <p className="text-[13px] text-destructive">{validationError ?? update.error?.message}</p>
          ) : saved ? (
            <p className="text-[13px] text-[#59D05D]">Saved.</p>
          ) : null}

          {canEdit ? (
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          ) : (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Settings2 className="size-4 shrink-0" />
              Only a workspace administrator can change these.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}
