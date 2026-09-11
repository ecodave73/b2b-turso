import { useState } from "react";
import { Link, useParams } from "wouter";
import {
  ArrowLeft,
  Building2,
  ExternalLink,
  Package,
  ShoppingCart,
  Users,
  Wallet,
} from "lucide-react";
import { AppShell } from "../../components/app-shell";
import { DataTable, type Column } from "../../components/data-table";
import { EmptyState } from "../../components/empty-state";
import { KpiTile } from "../../components/kpi-tile";
import { OrderStatusBadge } from "../../components/order-status-badge";
import { PageHeader } from "../../components/page-header";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { tenantPath } from "../../lib/tenant-path";
import { formatCents, formatDate, formatDateTime, formatNumber } from "../../lib/format";
import { useSetTenantActive, useTenantDetail, useUpdateTenantPlan } from "../../queries/platform";

/**
 * One tenant, everything the platform knows about it, plus the only two levers support has:
 * suspend/reactivate and the recorded plan.
 *
 * There is deliberately no delete button. `deleteTenantCascade()` exists in the guard and is
 * tested, but an irreversible wipe of a paying customer's data does not belong one click away
 * in a console — it stays a deliberate, deployed-code action.
 *
 * "Open as tenant" is navigation and nothing else: no impersonation state is created anywhere.
 * It must be a plain <a>, because the router's base is computed once at mount and a
 * client-side hop into /t/{sub} would leave every subsequent link resolving against the wrong
 * base.
 */
const PLAN_OPTIONS = ["starter", "professional", "enterprise"] as const;

type StatusRow = { status: string; orders: number; totalCents: number };
type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: Date | string;
};
type UserRow = { id: string; email: string; name: string | null; role: string; createdAt: Date | string };
type ActivityRow = {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  userEmail: string | null;
  createdAt: Date | string;
};

export default function AdminTenantDetail() {
  const params = useParams<{ tenantId: string }>();
  const tenantId = params.tenantId ?? "";
  const { data: tenant, isPending, error } = useTenantDetail(tenantId);

  if (error) {
    return (
      <AppShell>
        <BackLink />
        <PageHeader title="Tenant" />
        <Card>
          <CardContent>
            <EmptyState
              icon={Building2}
              title="We couldn't load this tenant"
              description={error.message}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/admin/tenants">Back to tenants</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const hostname = tenant?.customDomain ?? (tenant ? `${tenant.subdomain}` : "");

  return (
    <AppShell>
      <BackLink />

      <PageHeader
        title={tenant?.name ?? "Loading…"}
        description={hostname || undefined}
        actions={
          tenant ? (
            <a
              href={tenantPath(tenant.subdomain)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            >
              <ExternalLink className="size-4" />
              Open as tenant
            </a>
          ) : null
        }
      />

      {tenant ? (
        <div className="mb-6 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <Badge variant="muted">{tenant.plan}</Badge>
          <Badge variant={tenant.isActive ? "success" : "destructive"}>
            {tenant.isActive ? "Active" : "Suspended"}
          </Badge>
          {tenant.isSandbox ? <Badge variant="outline">Sandbox</Badge> : null}
          <span>
            Created {formatDate(tenant.createdAt)} · Updated {formatDateTime(tenant.updatedAt)}
          </span>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          tone="orange"
          icon={Wallet}
          label="Lifetime revenue"
          value={tenant ? formatCents(tenant.revenueCents) : "—"}
          hint={tenant ? `${formatCents(tenant.openOrderValueCents)} still open` : undefined}
          loading={isPending}
        />
        <KpiTile
          tone="green"
          icon={Building2}
          label="MRR (list price)"
          value={tenant ? formatCents(tenant.mrrCents) : "—"}
          hint={tenant?.isActive ? "Plan list price" : "Nothing while suspended"}
          loading={isPending}
        />
        <KpiTile
          tone="coral"
          icon={ShoppingCart}
          label="Orders"
          value={formatNumber(tenant?.orderCount ?? 0)}
          hint={tenant ? `${formatNumber(tenant.productCount)} products in catalogue` : undefined}
          loading={isPending}
        />
        <KpiTile
          tone="blue"
          icon={Users}
          label="Users"
          value={formatNumber(tenant?.userCount ?? 0)}
          loading={isPending}
        />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        {tenant ? <SubscriptionCard tenant={tenant} /> : <LoadingCard title="Subscription" />}

        <Card>
          <CardHeader>
            <CardTitle>Orders by status</CardTitle>
            <CardDescription>Where this tenant&apos;s order value is sitting.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <DataTable
              columns={statusColumns}
              data={tenant?.ordersByStatus as StatusRow[] | undefined}
              rowKey={(row) => row.status}
              isLoading={isPending}
              empty={<EmptyState icon={ShoppingCart} title="No orders yet" />}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Feature flags</CardTitle>
            <CardDescription>Set by the tenant, shown here read-only.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {isPending ? (
              <span className="block h-3 w-32 animate-pulse rounded bg-border" />
            ) : (tenant?.featureFlags.length ?? 0) === 0 ? (
              <EmptyState icon={Package} title="No flags set" description="Nothing has been toggled for this tenant." />
            ) : (
              tenant?.featureFlags.map((flag) => (
                <div key={flag.id} className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[12px] text-foreground">{flag.key}</span>
                  <Badge variant={flag.enabled ? "success" : "muted"}>{flag.enabled ? "on" : "off"}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Recent orders</CardTitle>
            <CardDescription>The ten most recent, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <DataTable
              columns={orderColumns}
              data={tenant?.recentOrders as OrderRow[] | undefined}
              rowKey={(row) => row.id}
              isLoading={isPending}
              empty={<EmptyState icon={ShoppingCart} title="No orders yet" description="This workspace hasn't placed one." />}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <CardDescription>Oldest first — the first row is usually the owner.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <DataTable
              columns={userColumns}
              data={tenant?.users as UserRow[] | undefined}
              rowKey={(row) => row.id}
              isLoading={isPending}
              empty={<EmptyState icon={Users} title="No users" description="Nobody has been invited into this workspace." />}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>This tenant&apos;s own audit trail, including platform visits.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <DataTable
            columns={activityColumns}
            data={tenant?.recentActivity as ActivityRow[] | undefined}
            rowKey={(row) => row.id}
            isLoading={isPending}
            empty={<EmptyState icon={Building2} title="Nothing recorded yet" />}
          />
        </CardContent>
      </Card>
    </AppShell>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/tenants"
      className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Back to tenants
    </Link>
  );
}

function LoadingCard({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <span className="block h-3 w-32 animate-pulse rounded bg-border" />
      </CardContent>
    </Card>
  );
}

type TenantDetail = NonNullable<ReturnType<typeof useTenantDetail>["data"]>;

function SubscriptionCard({ tenant }: { tenant: TenantDetail }) {
  const updatePlan = useUpdateTenantPlan();
  const setActive = useSetTenantActive();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");

  const busy = updatePlan.isPending || setActive.isPending;

  function onPlanChange(plan: string) {
    if (plan === tenant.plan) return;
    updatePlan.mutate({ tenantId: tenant.id, plan: plan as (typeof PLAN_OPTIONS)[number] });
  }

  function onToggleActive() {
    setActive.mutate(
      { tenantId: tenant.id, isActive: !tenant.isActive, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setConfirming(false);
          setReason("");
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription</CardTitle>
        <CardDescription>Plan, billing links and domain state.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Select
            value={tenant.plan}
            aria-label="Plan"
            disabled={busy}
            onChange={(event) => onPlanChange(event.target.value)}
          >
            {PLAN_OPTIONS.map((plan) => (
              <option key={plan} value={plan}>
                {plan}
              </option>
            ))}
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Changes the platform record and the MRR figure only — no Stripe subscription is moved. Billing
            arrives in a later phase.
          </p>
          {updatePlan.isError ? (
            <p className="text-[12px] text-destructive">{updatePlan.error.message}</p>
          ) : updatePlan.isSuccess ? (
            <p className="text-[12px] text-success">
              {updatePlan.data.changed ? "Plan updated." : "Already on that plan."}
            </p>
          ) : null}
        </div>

        <dl className="space-y-2 rounded-md border border-border p-3">
          <Fact label="Stripe customer" value={tenant.stripeCustomerId ?? "Not linked"} mono={!!tenant.stripeCustomerId} />
          <Fact label="Billing" value={tenant.billingConnected ? "Connected" : "Not connected"} />
          <Fact label="Square" value={tenant.squareConnected ? "Connected" : "Not connected"} />
          <Fact label="Domain" value={tenant.customDomain ?? tenant.subdomain} />
          <Fact label="Domain status" value={tenant.domainStatus ?? "—"} />
        </dl>

        <div className="border-t border-border pt-3">
          {confirming ? (
            <div className="space-y-2 rounded-md bg-muted p-3">
              <p className="text-[13px] font-medium text-foreground">
                {tenant.isActive ? `Suspend ${tenant.name}?` : `Reactivate ${tenant.name}?`}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {tenant.isActive
                  ? "The tenant keeps all of its data, but is marked inactive: it drops out of MRR and its members are locked out until you reactivate it. Suspension is an operational switch, not a billing one."
                  : "Members get access back immediately and the tenant returns to the MRR figure."}
              </p>
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reason (recorded in the audit log)"
                aria-label="Reason for this change"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={tenant.isActive ? "destructive" : "default"}
                  disabled={busy}
                  onClick={onToggleActive}
                >
                  {setActive.isPending ? "Saving…" : tenant.isActive ? "Suspend tenant" : "Reactivate tenant"}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
              {setActive.isError ? <p className="text-[12px] text-destructive">{setActive.error.message}</p> : null}
            </div>
          ) : (
            <Button
              size="sm"
              variant={tenant.isActive ? "outline" : "default"}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {tenant.isActive ? "Suspend tenant" : "Reactivate tenant"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className={`max-w-[60%] truncate text-[12px] text-foreground ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

const statusColumns: Column<StatusRow>[] = [
  { key: "status", header: "Status", render: (row) => <OrderStatusBadge status={row.status} /> },
  { key: "orders", header: "Orders", numeric: true, render: (row) => formatNumber(row.orders) },
  { key: "value", header: "Value", numeric: true, render: (row) => formatCents(row.totalCents) },
];

const orderColumns: Column<OrderRow>[] = [
  { key: "orderNumber", header: "Order", render: (row) => <span className="font-medium">{row.orderNumber}</span> },
  { key: "status", header: "Status", render: (row) => <OrderStatusBadge status={row.status} /> },
  {
    key: "createdAt",
    header: "Placed",
    render: (row) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.createdAt)}</span>,
  },
  {
    key: "total",
    header: "Total",
    numeric: true,
    render: (row) => formatCents(row.totalCents, row.currency),
  },
];

const userColumns: Column<UserRow>[] = [
  {
    key: "user",
    header: "User",
    render: (row) => (
      <span className="block min-w-0">
        <span className="block truncate font-medium text-foreground">{row.name ?? row.email}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{row.email}</span>
      </span>
    ),
  },
  {
    key: "role",
    header: "Role",
    render: (row) => <Badge variant={row.role === "TENANT_ADMIN" ? "primary" : "muted"}>{row.role.replace(/_/g, " ").toLowerCase()}</Badge>,
  },
];

const activityColumns: Column<ActivityRow>[] = [
  {
    key: "createdAt",
    header: "When",
    render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span>,
  },
  { key: "action", header: "Action", render: (row) => <span className="font-mono text-[12px]">{row.action}</span> },
  {
    key: "entity",
    header: "Entity",
    render: (row) => (
      <span className="text-muted-foreground">
        {row.entity ?? "—"}
        {row.entityId ? ` · ${row.entityId.slice(0, 8)}` : ""}
      </span>
    ),
  },
  {
    key: "actor",
    header: "Actor",
    render: (row) => <span className="text-muted-foreground">{row.userEmail ?? "System"}</span>,
  },
];
