import { useState } from "react";
import { Link } from "wouter";
import { ScrollText } from "lucide-react";
import { AppShell } from "../../components/app-shell";
import { DataTable, type Column } from "../../components/data-table";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { formatDateTime, formatNumber } from "../../lib/format";
import { usePlatformActivity, usePlatformTenants } from "../../queries/platform";

/**
 * The cross-tenant audit trail — every tenant's log, in one stream.
 *
 * Nothing on this page writes: a log its readers can edit is not a log. The actor column shows
 * the resolved email rather than the raw user id the old console printed, which is the one
 * thing that made the old page hard to read during an incident.
 *
 * Like the tenant list, the search box is a plain substring match with no ranking, so the copy
 * says "filter".
 */
type PlatformLogRow = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSubdomain: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  userEmail: string | null;
  createdAt: Date | string;
};

/**
 * The entity list is fixed rather than derived: `platform.activity` would have to scan every
 * tenant's log to answer "which entities exist", and these are the entities the code writes.
 */
const ENTITY_OPTIONS = ["tenant", "order", "product", "category", "user", "pricing", "shipping", "inventory"];
const ROW_OPTIONS = [50, 100, 250, 500];

export default function AdminActivity() {
  const [search, setSearch] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [entity, setEntity] = useState("");
  const [limit, setLimit] = useState(100);
  const [page, setPage] = useState(0);

  // The picker needs names, not ids — one page of tenants is enough to populate it.
  const { data: tenantList } = usePlatformTenants({ limit: 200, status: "all" });

  const { data, isPending, error } = usePlatformActivity({
    search: search.trim() || undefined,
    tenantId: tenantId || undefined,
    entity: entity || undefined,
    limit,
    offset: page * limit,
  });

  const rows = (data?.entries ?? []) as PlatformLogRow[];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * limit + 1;

  const columns: Column<PlatformLogRow>[] = [
    {
      key: "createdAt",
      header: "When",
      render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: "tenant",
      header: "Tenant",
      render: (row) => (
        <Link href={`/admin/tenants/${row.tenantId}`} className="font-medium text-primary hover:underline">
          {row.tenantName ?? row.tenantSubdomain ?? row.tenantId.slice(0, 8)}
        </Link>
      ),
    },
    { key: "action", header: "Action", render: (row) => <span className="font-mono text-[12px]">{row.action}</span> },
    {
      key: "entity",
      header: "Entity",
      render: (row) => (row.entity ? <Badge variant="muted">{row.entity}</Badge> : <span className="text-muted-foreground">—</span>),
    },
    {
      key: "entityId",
      header: "Entity ID",
      render: (row) => (
        <span className="font-mono text-[12px] text-muted-foreground">{row.entityId ? row.entityId.slice(0, 8) : "—"}</span>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      render: (row) => <span className="text-muted-foreground">{row.userEmail ?? "System"}</span>,
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Platform Activity"
        description="Cross-tenant audit trail of every action recorded on the platform."
        actions={
          <div className="text-right">
            <p className="text-[11px] text-muted-foreground">Matching events</p>
            <p className="text-[15px] font-semibold text-foreground tabular-nums">{formatNumber(total)}</p>
          </div>
        }
      />

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle>Audit trail</CardTitle>
            <CardDescription>Newest first, across every tenant.</CardDescription>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              placeholder="Filter by action, e.g. order.created"
              aria-label="Filter by action"
            />
            <Select
              value={tenantId}
              aria-label="Filter by tenant"
              onChange={(event) => {
                setTenantId(event.target.value);
                setPage(0);
              }}
            >
              <option value="">All tenants</option>
              {(tenantList?.tenants ?? []).map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </Select>
            <Select
              value={entity}
              aria-label="Filter by entity"
              onChange={(event) => {
                setEntity(event.target.value);
                setPage(0);
              }}
            >
              <option value="">All entities</option>
              {ENTITY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <Select
              value={String(limit)}
              aria-label="Rows per page"
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setPage(0);
              }}
            >
              {ROW_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} rows
                </option>
              ))}
            </Select>
          </div>
        </CardHeader>

        <CardContent className="px-0 pt-4 pb-0">
          <DataTable
            columns={columns}
            data={rows}
            rowKey={(row) => row.id}
            isLoading={isPending}
            error={error}
            empty={
              <EmptyState
                icon={ScrollText}
                title="No activity recorded"
                description="Actions taken by any tenant will appear here. Clear the filters if you expected rows."
              />
            }
          />
        </CardContent>

        {total > limit && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
            <span className="text-[12px] text-muted-foreground">
              Showing {from}–{page * limit + rows.length} of {formatNumber(total)}
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
                disabled={(page + 1) * limit >= total}
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
