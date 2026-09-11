import { Link } from "wouter";
import { Building2, ShoppingCart, Users, Wallet } from "lucide-react";
import { AppShell } from "../../components/app-shell";
import { EmptyState } from "../../components/empty-state";
import { KpiTile } from "../../components/kpi-tile";
import { PageHeader } from "../../components/page-header";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { formatCents, formatCentsCompact, formatNumber } from "../../lib/format";
import { usePlatformStats } from "../../queries/platform";

/**
 * The mothership overview: every tenant on the platform, folded into one screen.
 *
 * Two honest labels on this page are deliberate, not hedging:
 *   - MRR is list price × active tenants, taken from the plan each tenant is recorded on. It is
 *     not collected revenue and it is not Stripe's opinion; billing arrives in phase 6b and
 *     replaces this number at its source.
 *   - GMV counts PAID and CLOSED orders across every tenant, so it is platform turnover, not
 *     platform income.
 * Saying so on the tile beats a number nobody can reconcile.
 *
 * The two trends are drawn with CSS-height bars rather than a chart library. No charting
 * dependency is installed, and a 30-point daily series does not need one.
 */
export default function AdminOverview() {
  const { data: stats, isPending, error } = usePlatformStats();

  const tenantsTotal = stats?.tenantsTotal ?? 0;
  const currency = stats?.currency ?? "AUD";

  return (
    <AppShell>
      <PageHeader
        title="Platform Overview"
        description="Every tenant on the platform, at a glance."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/tenants">Manage tenants</Link>
          </Button>
        }
      />

      {error ? (
        <Card className="mb-6">
          <CardContent className="text-[13px] text-destructive">{error.message}</CardContent>
        </Card>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          tone="orange"
          icon={Building2}
          label="Tenants"
          value={formatNumber(tenantsTotal)}
          hint={stats ? `${formatNumber(stats.tenantsActive)} active · ${formatNumber(stats.tenantsSuspended)} suspended` : undefined}
          loading={isPending}
        />
        <KpiTile
          tone="green"
          icon={Wallet}
          label="MRR (list price)"
          value={stats ? formatCentsCompact(stats.mrrTotalCents, currency) : "—"}
          hint="Plan list price, not billed revenue"
          loading={isPending}
        />
        <KpiTile
          tone="coral"
          icon={ShoppingCart}
          label="Platform GMV"
          value={stats ? formatCentsCompact(stats.gmvCents, currency) : "—"}
          hint={stats ? `${formatCentsCompact(stats.gmvLast30DaysCents, currency)} in last 30 days` : undefined}
          loading={isPending}
        />
        <KpiTile
          tone="blue"
          icon={Users}
          label="Users"
          value={formatNumber(stats?.usersTotal ?? 0)}
          hint={
            stats
              ? `across ${formatNumber(stats.tenantsTotal)} ${stats.tenantsTotal === 1 ? "workspace" : "workspaces"}`
              : undefined
          }
          loading={isPending}
        />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Orders &amp; revenue</CardTitle>
            <CardDescription>
              Paid and closed order value per day, last {stats?.trendDays ?? 30} days, across every tenant.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrendBars
              points={(stats?.ordersTrend ?? []).map((point) => ({
                date: point.date,
                value: point.revenueCents,
                label: `${formatNumber(point.orders)} ${point.orders === 1 ? "order" : "orders"} · ${formatCents(point.revenueCents, currency)}`,
              }))}
              isLoading={isPending}
              barClass="bg-chart-1"
              formatValue={(value) => formatCentsCompact(value, currency)}
              emptyMessage="No paid orders on the platform yet."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan mix</CardTitle>
            <CardDescription>Active tenants per plan, and what each plan lists at.</CardDescription>
          </CardHeader>
          <CardContent>
            <PlanMix rows={stats?.mrrByPlan} currency={currency} isLoading={isPending} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Tenant signups</CardTitle>
            <CardDescription>New workspaces per day, last {stats?.trendDays ?? 30} days.</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendBars
              points={(stats?.signupTrend ?? []).map((point) => ({
                date: point.date,
                value: point.tenants,
                label: `${formatNumber(point.tenants)} ${point.tenants === 1 ? "signup" : "signups"}`,
              }))}
              isLoading={isPending}
              barClass="bg-chart-2"
              formatValue={(value) => formatNumber(value)}
              emptyMessage="No signups in this window."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Breakdown</CardTitle>
            <CardDescription>Who is on the platform, and what is still moving.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-[12px] font-medium text-muted-foreground">Users by role</p>
              {isPending ? (
                <span className="block h-3 w-32 animate-pulse rounded bg-border" />
              ) : (stats?.usersByRole.length ?? 0) === 0 ? (
                <p className="text-[13px] text-muted-foreground">No users yet.</p>
              ) : (
                stats?.usersByRole.map((row) => (
                  <div key={row.role} className="flex items-center justify-between gap-3">
                    <Badge variant={row.role === "SUPER_ADMIN" ? "primary" : "muted"}>
                      {row.role.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                    <span className="text-[13px] font-medium tabular-nums">{formatNumber(row.users)}</span>
                  </div>
                ))
              )}
            </div>

            <dl className="space-y-2 rounded-md border border-border p-3">
              <FactRow label="Open order value" value={stats ? formatCents(stats.openValueCents, currency) : "—"} />
              <FactRow label={`Orders (${stats?.trendDays ?? 30}d)`} value={formatNumber(stats?.ordersLast30Days ?? 0)} />
              <FactRow label="Orders (all-time)" value={formatNumber(stats?.ordersTotal ?? 0)} />
              <FactRow label="New tenants this month" value={formatNumber(stats?.tenantsNewThisMonth ?? 0)} />
              <FactRow label="Sandbox tenants" value={formatNumber(stats?.tenantsSandbox ?? 0)} />
            </dl>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[13px] font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

type TrendPoint = { date: string; value: number; label: string };

/**
 * A 30-bar daily series. The axis is pre-seeded by the server, so a day with nothing still gets
 * a slot and the shape of the month stays honest — gaps are not silently closed up.
 */
function TrendBars({
  points,
  isLoading,
  barClass,
  formatValue,
  emptyMessage,
}: {
  points: TrendPoint[];
  isLoading: boolean;
  barClass: string;
  formatValue: (value: number) => string;
  emptyMessage: string;
}) {
  if (isLoading) return <div className="h-40 animate-pulse rounded-md bg-muted" />;

  const peak = points.reduce((max, point) => Math.max(max, point.value), 0);

  if (points.length === 0 || peak === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md bg-muted text-[13px] text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <div className="flex h-40 items-end gap-[3px]">
        {points.map((point) => (
          <div
            key={point.date}
            title={`${shortDate(point.date)} · ${point.label}`}
            className="flex h-full flex-1 items-end"
          >
            <div
              className={`w-full rounded-t-[2px] ${barClass}`}
              // A zero day still gets a 2px sliver so the axis reads as a continuous series
              // rather than a row of missing bars.
              style={{ height: point.value === 0 ? "2px" : `${Math.max(4, (point.value / peak) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{shortDate(points[0]!.date)}</span>
        <span>Peak {formatValue(peak)}</span>
        <span>{shortDate(points[points.length - 1]!.date)}</span>
      </div>
    </div>
  );
}

function PlanMix({
  rows,
  currency,
  isLoading,
}: {
  rows: { plan: string; listPriceCents: number; tenants: number; mrrCents: number }[] | undefined;
  currency: string;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((row) => (
          <span key={row} className="block h-6 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  const list = rows ?? [];
  const total = list.reduce((sum, row) => sum + row.mrrCents, 0);

  if (list.every((row) => row.tenants === 0)) {
    return <EmptyState icon={Building2} title="No tenants yet" description="Plan mix appears once a workspace signs up." />;
  }

  const barColours = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

  return (
    <div className="space-y-3">
      {list.map((row, index) => (
        <div key={row.plan}>
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="font-medium capitalize">{row.plan}</span>
            <span className="text-muted-foreground tabular-nums">
              {formatNumber(row.tenants)} · {formatCents(row.mrrCents, currency)}/mo
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${barColours[index % barColours.length]}`}
              style={{ width: total > 0 ? `${(row.mrrCents / total) * 100}%` : "0%" }}
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Lists at {formatCents(row.listPriceCents, currency)}/mo
          </p>
        </div>
      ))}
      <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
        Suspended tenants count nothing towards MRR.
      </p>
    </div>
  );
}

/** The trend keys are UTC day strings from the server — read them back in UTC or they drift. */
function shortDate(key: string): string {
  const parsed = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return key;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }).format(parsed);
}
