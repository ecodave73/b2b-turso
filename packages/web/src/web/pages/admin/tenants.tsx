import { useState } from "react";
import { useLocation } from "wouter";
import { Building2, ChevronRight } from "lucide-react";
import { AppShell } from "../../components/app-shell";
import { DataTable, type Column } from "../../components/data-table";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { formatCents, formatDate, formatNumber, pluralize } from "../../lib/format";
import { usePlatformTenants, type PlatformTenantFilters } from "../../queries/platform";

/**
 * Every tenant on the platform, newest first.
 *
 * The search box is a plain substring match over name, subdomain and custom domain — there is
 * no relevance ranking behind it, so the copy says "filter", never "best match". Full-text
 * search lands with FTS5 in phase 6a and this page is one of the two callers that gets it.
 */
type TenantRow = {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  plan: string;
  isActive: boolean;
  isSandbox: boolean;
  brandColor: string | null;
  userCount: number;
  productCount: number;
  orderCount: number;
  revenueCents: number;
  mrrCents: number;
  lastActivityAt: Date | string | null;
  createdAt: Date | string;
};

const PAGE_SIZE = 50;
const PLAN_OPTIONS = ["starter", "professional", "enterprise"] as const;

export default function AdminTenants() {
  const [, navigate] = useLocation();

  const [search, setSearch] = useState("");
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "suspended">("all");
  const [includeSandbox, setIncludeSandbox] = useState(true);
  const [page, setPage] = useState(0);

  const filters: PlatformTenantFilters = {
    search: search.trim() || undefined,
    plan: (plan || undefined) as PlatformTenantFilters["plan"],
    status,
    includeSandbox,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const { data, isPending, error } = usePlatformTenants(filters);

  const rows = (data?.tenants ?? []) as TenantRow[];
  const total = data?.total ?? 0;
  const filteredMrr = rows.reduce((sum, row) => sum + row.mrrCents, 0);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;

  function resetToFirstPage<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(0);
    };
  }

  const columns: Column<TenantRow>[] = [
    {
      key: "tenant",
      header: "Tenant",
      render: (row) => (
        <div className="flex items-center gap-3">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-white"
            style={{ backgroundColor: row.brandColor ?? "#1a1a2e" }}
          >
            <Building2 className="size-4" strokeWidth={1.75} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-foreground">{row.name}</span>
              {row.isSandbox ? <Badge variant="outline">Sandbox</Badge> : null}
            </span>
            <span className="block truncate text-[12px] text-muted-foreground">
              {row.customDomain ?? row.subdomain}
            </span>
          </span>
        </div>
      ),
    },
    { key: "plan", header: "Plan", render: (row) => <Badge variant="muted">{row.plan}</Badge> },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className={`size-2 rounded-full ${row.isActive ? "bg-success" : "bg-destructive"}`} />
          <span className="text-[13px]">{row.isActive ? "Active" : "Suspended"}</span>
        </span>
      ),
    },
    {
      key: "usage",
      header: "Usage",
      render: (row) => (
        <span className="whitespace-nowrap text-[12px] text-muted-foreground tabular-nums">
          {pluralize(row.userCount, "user")} · {pluralize(row.productCount, "product")} ·{" "}
          {pluralize(row.orderCount, "order")}
        </span>
      ),
    },
    {
      key: "revenue",
      header: "Revenue",
      numeric: true,
      render: (row) => (
        <span className="block whitespace-nowrap">
          <span className="block font-medium">{formatCents(row.revenueCents)}</span>
          <span className="block text-[11px] text-muted-foreground">{formatCents(row.mrrCents)}/mo</span>
        </span>
      ),
    },
    {
      key: "lastActivity",
      header: "Last activity",
      render: (row) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {row.lastActivityAt ? formatDate(row.lastActivityAt) : "—"}
        </span>
      ),
    },
    {
      key: "open",
      header: "",
      render: () => <ChevronRight className="size-4 text-muted-foreground" />,
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Tenants"
        description="Every workspace on the platform, newest first."
        actions={
          <div className="text-right">
            <p className="text-[11px] text-muted-foreground">MRR on this page</p>
            <p className="text-[15px] font-semibold text-foreground tabular-nums">{formatCents(filteredMrr)}</p>
          </div>
        }
      />

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle>All tenants</CardTitle>
            <CardDescription>
              {total > 0
                ? `${pluralize(total, "tenant")} ${total === 1 ? "matches" : "match"} these filters`
                : "No tenants match these filters"}
            </CardDescription>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Input
              value={search}
              onChange={(event) => resetToFirstPage(setSearch)(event.target.value)}
              placeholder="Filter by name, subdomain or domain"
              aria-label="Filter tenants by name, subdomain or custom domain"
            />
            <Select
              value={plan}
              aria-label="Filter by plan"
              onChange={(event) => resetToFirstPage(setPlan)(event.target.value)}
            >
              <option value="">All plans</option>
              {PLAN_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <Select
              value={status}
              aria-label="Filter by status"
              onChange={(event) =>
                resetToFirstPage(setStatus)(event.target.value as "all" | "active" | "suspended")
              }
            >
              <option value="all">Active &amp; suspended</option>
              <option value="active">Active only</option>
              <option value="suspended">Suspended only</option>
            </Select>
            <label className="flex items-center gap-2 self-center text-[13px] text-muted-foreground">
              <input
                type="checkbox"
                aria-label="Include sandbox tenants"
                checked={includeSandbox}
                onChange={(event) => resetToFirstPage(setIncludeSandbox)(event.target.checked)}
                className="size-4 rounded border-border accent-primary"
              />
              Include sandbox tenants
            </label>
          </div>
        </CardHeader>

        <CardContent className="px-0 pt-4 pb-0">
          <DataTable
            columns={columns}
            data={rows}
            rowKey={(row) => row.id}
            isLoading={isPending}
            error={error}
            onRowClick={(row) => navigate(`/admin/tenants/${row.id}`)}
            empty={
              <EmptyState
                icon={Building2}
                title="No tenants match those filters"
                description="Try clearing the search, or switching the plan and status filters."
              />
            }
          />
        </CardContent>

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
            <span className="text-[12px] text-muted-foreground">
              Showing {from}–{page * PAGE_SIZE + rows.length} of {formatNumber(total)}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
