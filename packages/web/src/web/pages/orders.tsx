import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import { ClipboardList, X } from "lucide-react";
import { AppShell, isBackOfficeRole } from "../components/app-shell";
import { DataTable, type Column } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { OrderStatusBadge } from "../components/order-status-badge";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { formatCents, formatDateTime, formatNumber } from "../lib/format";
import { ORDER_STATUSES, nextStatuses, type OrderStatus } from "../lib/order-flow";
import { useOrder, useOrders, useUpdateOrderStatus } from "../queries/orders";
import { useCurrentSession } from "../queries/session";

/**
 * Orders. The list is every order in the tenant — the same thing the old stack's `listOrders`
 * returned to a buyer, so this is parity, not a widening.
 *
 * Selecting a row opens the detail panel from `orders.get`: line items priced at the moment
 * they were ordered, the company the order belongs to, and any payments recorded against it.
 * The status buttons come from the state machine mirror in lib/order-flow.ts and are shown to
 * back-office roles only — but it is the SERVER that refuses an illegal move, and its error is
 * rendered rather than swallowed.
 */
type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  totalCents: number;
  currency: string;
  poNumber: string | null;
  createdAt: Date | string;
  itemCount: number;
};

const PAGE_SIZE = 50;

export default function Orders() {
  const { data: session } = useCurrentSession();
  const canManage = isBackOfficeRole(session?.user?.role);

  // The dashboard links here with ?order={id}; that deep link has to actually open the order.
  const searchString = useSearch();
  const linkedOrderId = useMemo(
    () => new URLSearchParams(searchString).get("order"),
    [searchString],
  );

  const [status, setStatus] = useState<"" | OrderStatus>("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(linkedOrderId);

  useEffect(() => {
    if (linkedOrderId) setSelectedId(linkedOrderId);
  }, [linkedOrderId]);

  const {
    data: orders,
    isPending,
    error,
  } = useOrders({
    status: status || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const columns: Column<OrderRow>[] = [
    {
      key: "orderNumber",
      header: "Order",
      render: (row) => <span className="font-medium">{row.orderNumber}</span>,
    },
    { key: "status", header: "Status", render: (row) => <OrderStatusBadge status={row.status} /> },
    { key: "items", header: "Items", numeric: true, render: (row) => formatNumber(row.itemCount) },
    {
      key: "total",
      header: "Total",
      numeric: true,
      render: (row) => formatCents(row.totalCents, row.currency),
    },
    {
      key: "po",
      header: "PO number",
      render: (row) => <span className="text-muted-foreground">{row.poNumber || "—"}</span>,
    },
    {
      key: "createdAt",
      header: "Placed",
      render: (row) => <span className="text-muted-foreground">{formatDateTime(row.createdAt)}</span>,
    },
  ];

  const atPageEnd = !orders || orders.length < PAGE_SIZE;

  return (
    <AppShell>
      <PageHeader
        title="Orders"
        description="Every order in this workspace, newest first. Select one to see its lines, company and payments."
      />

      {selectedId ? (
        <OrderDetail id={selectedId} canManage={canManage} onClose={() => setSelectedId(null)} />
      ) : null}

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle>Order list</CardTitle>
            <CardDescription>
              Totals include tax. Prices on each line are the ones captured when the order was raised.
            </CardDescription>
          </div>
          <div className="sm:max-w-[220px]">
            <Select
              value={status}
              aria-label="Filter by status"
              onChange={(event) => {
                setStatus(event.target.value as "" | OrderStatus);
                setPage(0);
              }}
            >
              <option value="">All statuses</option>
              {ORDER_STATUSES.map((value) => (
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
            data={orders}
            rowKey={(row) => row.id}
            isLoading={isPending}
            error={error}
            onRowClick={(row) => setSelectedId(row.id)}
            isRowActive={(row) => row.id === selectedId}
            empty={
              <EmptyState
                icon={ClipboardList}
                title={status ? `No ${status} orders` : "No orders yet"}
                description={
                  status
                    ? "Clear the status filter to see the rest of the workspace's orders."
                    : "Orders appear here once a buyer checks out or you raise one from the back office."
                }
              />
            }
          />
        </CardContent>
        {(page > 0 || !atPageEnd) && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
            <span className="text-[12px] text-muted-foreground">
              Showing {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + (orders?.length ?? 0)}
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
                disabled={atPageEnd}
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

function OrderDetail({
  id,
  canManage,
  onClose,
}: {
  id: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const { data: order, isPending, error } = useOrder(id);
  const updateStatus = useUpdateOrderStatus();

  if (isPending) {
    return (
      <Card className="mb-4">
        <CardContent className="text-[13px] text-muted-foreground">Loading order…</CardContent>
      </Card>
    );
  }

  if (error || !order) {
    return (
      <Card className="mb-4">
        <CardContent className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-destructive">
            {error?.message ?? "That order could not be loaded."}
          </p>
          <Button variant="ghost" size="icon-sm" aria-label="Close order" onClick={onClose}>
            <X className="size-4 text-muted-foreground" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  const targets = nextStatuses(order.status);

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            {order.orderNumber}
            <OrderStatusBadge status={order.status} />
          </CardTitle>
          <CardDescription>
            Placed {formatDateTime(order.createdAt)}
            {order.company ? ` · ${order.company.name}` : ""}
            {order.poNumber ? ` · PO ${order.poNumber}` : ""}
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close order" onClick={onClose}>
          <X className="size-4 text-muted-foreground" />
        </Button>
      </CardHeader>

      <CardContent className="space-y-5 px-0 pt-4 pb-0">
        <Table>
          <TableHeader>
            <tr>
              <TableHead>SKU</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit</TableHead>
              <TableHead className="text-right">Line total</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {order.lineItems.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="font-medium">{line.sku ?? "—"}</TableCell>
                <TableCell>{line.name ?? "Product removed from catalogue"}</TableCell>
                <TableCell className="numeric">{formatNumber(line.quantity)}</TableCell>
                <TableCell className="numeric">
                  {formatCents(line.unitPriceCents, order.currency)}
                </TableCell>
                <TableCell className="numeric">
                  {formatCents(line.totalPriceCents, order.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="grid gap-6 px-6 pb-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-secondary-foreground uppercase">Totals</h3>
            <dl className="space-y-1 text-[13px]">
              <TotalRow label="Subtotal" value={formatCents(order.subtotalCents, order.currency)} />
              <TotalRow label="Tax" value={formatCents(order.taxTotalCents, order.currency)} />
              <TotalRow label="Shipping" value={formatCents(order.shippingCostCents, order.currency)} />
              <TotalRow
                label="Total"
                value={formatCents(order.totalCents, order.currency)}
                emphasis
              />
            </dl>
            {order.shippingAddress ? (
              <p className="mt-3 text-[13px] whitespace-pre-line text-muted-foreground">
                {order.shippingAddress}
              </p>
            ) : null}
            {order.notes ? (
              <p className="mt-3 text-[13px] whitespace-pre-line text-muted-foreground">{order.notes}</p>
            ) : null}
          </div>

          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-secondary-foreground uppercase">Payments</h3>
            {order.payments.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                Nothing recorded against this order yet.
              </p>
            ) : (
              <ul className="space-y-1 text-[13px]">
                {order.payments.map((payment) => (
                  <li key={payment.id} className="flex justify-between gap-3">
                    <span className="text-muted-foreground">
                      {payment.method} · {payment.status}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                    </span>
                    <span className="tabular-nums">
                      {formatCents(payment.amountCents, order.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {canManage ? (
              <div className="mt-5">
                <h3 className="mb-2 text-[12px] font-semibold text-secondary-foreground uppercase">
                  Move this order
                </h3>
                {targets.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    {order.status} is a terminal state — there is nowhere left to move it.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {targets.map((target) => (
                      <Button
                        key={target}
                        size="sm"
                        variant={target === "CANCELLED" ? "destructive" : "default"}
                        disabled={updateStatus.isPending}
                        onClick={() => updateStatus.mutate({ id: order.id, status: target })}
                      >
                        {updateStatus.isPending ? "Saving…" : `Mark ${target}`}
                      </Button>
                    ))}
                  </div>
                )}
                {updateStatus.error ? (
                  <p className="mt-2 text-[13px] text-destructive">{updateStatus.error.message}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TotalRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${emphasis ? "font-semibold text-foreground" : ""}`}>
      <dt className={emphasis ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
