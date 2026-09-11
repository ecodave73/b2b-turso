import { useState } from "react";
import { ScrollText } from "lucide-react";
import { AppShell, isBackOfficeRole } from "../components/app-shell";
import { DataTable, type Column } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { formatDateTime } from "../lib/format";
import { useActivityActions, useActivityLog } from "../queries/activity";
import { useCurrentSession } from "../queries/session";

/**
 * The audit trail. Rows are only ever written by the features that cause them — nothing on this
 * page creates or edits an entry, because a log its readers can write is not a log.
 *
 * Back-office only, matching the server gate. The filter is fed by the action strings this
 * tenant has actually recorded, so it cannot drift the way the old page's hardcoded list did.
 */
type LogRow = {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  details: unknown;
  userEmail: string | null;
  createdAt: Date | string;
};

const PAGE_SIZE = 50;

export default function Activity() {
  const { data: session } = useCurrentSession();
  const allowed = isBackOfficeRole(session?.user?.role);

  const [action, setAction] = useState("");
  const [page, setPage] = useState(0);

  const { data: actions } = useActivityActions();
  const { data, isPending, error } = useActivityLog({
    action: action || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const columns: Column<LogRow>[] = [
    {
      key: "createdAt",
      header: "When",
      render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span>,
    },
    { key: "action", header: "Action", render: (row) => <span className="font-medium">{row.action}</span> },
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
    {
      key: "details",
      header: "Details",
      render: (row) => <DetailsCell details={row.details} />,
    },
  ];

  if (!allowed) {
    return (
      <AppShell>
        <PageHeader title="Activity" />
        <Card>
          <CardContent>
            <EmptyState
              icon={ScrollText}
              title="Back-office only"
              description="The workspace audit trail is visible to administrators and staff."
            />
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const total = data?.total ?? 0;
  const shown = data?.entries.length ?? 0;
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;

  return (
    <AppShell>
      <PageHeader
        title="Activity"
        description="Everything this workspace has done, newest first — orders, stock movements, pricing and settings changes."
      />

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle>Audit trail</CardTitle>
            <CardDescription>
              {total > 0
                ? `${total.toLocaleString("en-AU")} ${total === 1 ? "entry" : "entries"} recorded`
                : "Nothing recorded yet"}
            </CardDescription>
          </div>
          <div className="sm:max-w-[280px]">
            <Select
              value={action}
              aria-label="Filter by action"
              onChange={(event) => {
                setAction(event.target.value);
                setPage(0);
              }}
            >
              <option value="">All actions</option>
              {(actions ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
        </CardHeader>
        <CardContent className="px-0 pt-4 pb-0">
          <DataTable
            columns={columns}
            data={data?.entries}
            rowKey={(row) => row.id}
            isLoading={isPending}
            error={error}
            empty={
              <EmptyState
                icon={ScrollText}
                title={action ? `No ${action} entries` : "Nothing logged yet"}
                description={
                  action
                    ? "Clear the filter to see the rest of the trail."
                    : "The log fills itself as orders, stock and settings change."
                }
              />
            }
          />
        </CardContent>
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
            <span className="text-[12px] text-muted-foreground">
              Showing {from}–{page * PAGE_SIZE + shown} of {total.toLocaleString("en-AU")}
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

function DetailsCell({ details }: { details: unknown }) {
  if (details === null || details === undefined) return <span className="text-muted-foreground">—</span>;

  const text = typeof details === "string" ? details : JSON.stringify(details);
  if (!text || text === "{}") return <span className="text-muted-foreground">—</span>;

  return (
    <span className="block max-w-[340px] truncate text-[12px] text-muted-foreground" title={text}>
      {text}
    </span>
  );
}
