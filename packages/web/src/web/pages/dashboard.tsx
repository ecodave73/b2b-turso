import { Link } from "wouter";
import { AlertTriangle, ClipboardList, Package, ShoppingCart, Wallet } from "lucide-react";
import { AppShell, isBackOfficeRole } from "../components/app-shell";
import { DataTable, type Column } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { KpiTile } from "../components/kpi-tile";
import { OrderStatusBadge } from "../components/order-status-badge";
import { PageHeader } from "../components/page-header";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../components/ui/card";
import { formatCents, formatCentsCompact, formatDate, formatNumber } from "../lib/format";
import { useCartSummary } from "../queries/cart";
import { useDashboardStats, useLowStock } from "../queries/dashboard";
import { useOrders } from "../queries/orders";
import { useCurrentSession } from "../queries/session";

/**
 * Two dashboards behind one route, chosen by role.
 *
 * Back office gets the aggregates (dashboard.stats, tenantStaff on the server). A buyer cannot
 * call that procedure at all, so their dashboard is built from what is theirs — their orders
 * and their cart. This is a split of substance, not of styling: showing a buyer an empty
 * revenue tile would be worse than showing them nothing.
 */
export default function Dashboard() {
  const { data: session } = useCurrentSession();
  const backOffice = isBackOfficeRole(session?.user?.role);

  return <AppShell>{backOffice ? <BackOfficeDashboard /> : <ClientDashboard />}</AppShell>;
}

type RecentOrder = {
  id: string;
  orderNumber: string;
  status: string;
  totalCents: number;
  currency: string;
  itemCount: number;
  createdAt: Date | string;
};

function recentOrderColumns(): Column<RecentOrder>[] {
  return [
    {
      key: "orderNumber",
      header: "Order",
      render: (row) => (
        <Link href={`/orders?order=${row.id}`} className="font-medium text-primary hover:underline">
          {row.orderNumber}
        </Link>
      ),
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
      key: "createdAt",
      header: "Placed",
      render: (row) => <span className="text-muted-foreground">{formatDate(row.createdAt)}</span>,
    },
  ];
}

function BackOfficeDashboard() {
  const { data: stats, isPending, error } = useDashboardStats();
  const { data: lowStock, isPending: lowStockPending } = useLowStock(5);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Stock health, order flow and revenue for this workspace."
      />

      {error ? (
        <Card className="mb-6">
          <CardContent className="text-[13px] text-destructive">{error.message}</CardContent>
        </Card>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          tone="orange"
          icon={ShoppingCart}
          label="Open orders"
          value={formatNumber(stats?.orders.open ?? 0)}
          hint={stats ? `${formatCentsCompact(stats.openValueCents)} in flight` : undefined}
          loading={isPending}
        />
        <KpiTile
          tone="green"
          icon={Wallet}
          label="Revenue (paid & closed)"
          value={stats ? formatCentsCompact(stats.revenueCents) : "—"}
          loading={isPending}
        />
        <KpiTile
          tone="coral"
          icon={AlertTriangle}
          label="Below minimum order qty"
          value={formatNumber(stats?.products.lowStock ?? 0)}
          hint="Stock under MOQ"
          loading={isPending}
        />
        <KpiTile
          tone="blue"
          icon={Package}
          label="Active products"
          value={formatNumber(stats?.products.active ?? 0)}
          hint={stats ? `${formatNumber(stats.products.total)} total` : undefined}
          loading={isPending}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Recent orders</CardTitle>
            <CardDescription>The five most recent orders in this workspace.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pt-4 pb-0">
            <DataTable
              columns={recentOrderColumns()}
              data={stats?.recentOrders}
              rowKey={(row) => row.id}
              isLoading={isPending}
              empty={
                <EmptyState
                  icon={ClipboardList}
                  title="No orders yet"
                  description="Orders raised in the back office or placed through the storefront appear here."
                />
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Low stock</CardTitle>
            <CardDescription>
              Active products whose on-hand quantity has fallen below their MOQ.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            {lowStockPending ? (
              <p className="text-[13px] text-muted-foreground">Loading…</p>
            ) : !lowStock || lowStock.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                Every active product holds at least its minimum order quantity.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {lowStock.map((product) => (
                  <li key={product.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">{product.name}</p>
                      <p className="text-[11px] text-muted-foreground">{product.sku}</p>
                    </div>
                    <div className="text-right text-[12px] whitespace-nowrap tabular-nums">
                      <span className="font-semibold text-destructive">
                        {formatNumber(product.stockOnHand)}
                      </span>
                      <span className="text-muted-foreground"> / {formatNumber(product.moq)} MOQ</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/inventory"
              className="mt-4 inline-block text-[12px] font-medium text-primary hover:underline"
            >
              Record stock movements →
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ClientDashboard() {
  const { data: session } = useCurrentSession();
  const { data: orders, isPending: ordersPending } = useOrders({ limit: 5 });
  const { data: cart, isPending: cartPending } = useCartSummary();

  const openOrders = (orders ?? []).filter(
    (order) => order.status !== "CLOSED" && order.status !== "CANCELLED",
  ).length;

  return (
    <>
      <PageHeader
        title={`Welcome${session?.user?.name ? `, ${session.user.name}` : ""}`}
        description={`Your orders and cart with ${session?.tenant?.name ?? "this supplier"}.`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiTile
          tone="orange"
          icon={ShoppingCart}
          label="Orders in progress"
          value={formatNumber(openOrders)}
          loading={ordersPending}
        />
        <KpiTile
          tone="blue"
          icon={Package}
          label="Items in cart"
          value={formatNumber(cart?.itemCount ?? 0)}
          loading={cartPending}
        />
        <KpiTile
          tone="green"
          icon={Wallet}
          label="Cart total (inc. tax)"
          value={cart ? formatCents(cart.totalCents, cart.currency) : "—"}
          loading={cartPending}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your recent orders</CardTitle>
          <CardDescription>The five most recent orders on your account.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pt-4 pb-0">
          <DataTable
            columns={recentOrderColumns()}
            data={orders}
            rowKey={(row) => row.id}
            isLoading={ordersPending}
            empty={
              <EmptyState
                icon={ClipboardList}
                title="No orders yet"
                description="Once you place an order it will appear here with its live status."
              />
            }
          />
        </CardContent>
      </Card>
    </>
  );
}
