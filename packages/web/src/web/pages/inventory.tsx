import { useState } from "react";
import { Boxes, History, X } from "lucide-react";
import { AppShell, isBackOfficeRole } from "../components/app-shell";
import { DataTable, type Column } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { formatDateTime, formatNumber } from "../lib/format";
import { useProducts } from "../queries/catalog";
import { useRecordInventoryEvent, useStockHistory } from "../queries/inventory";
import { useCurrentSession } from "../queries/session";

/**
 * Stock. On-hand is DERIVED from the event log and never stored, so this page has no "set the
 * quantity to N" control by design — correcting a count means appending an ADJUSTED event, and
 * the history below always explains the number above it.
 *
 * Quantities are signed: negative removes stock. That is the old page's wording kept verbatim,
 * because it is the one thing a warehouse user gets wrong.
 */
const EVENT_TYPES = ["RECEIVED", "SOLD", "ADJUSTED", "RETURNED", "TRANSFERRED"] as const;
type EventType = (typeof EVENT_TYPES)[number];

type StockRow = {
  id: string;
  sku: string;
  name: string;
  moq: number;
  stockOnHand: number | null;
};

export default function Inventory() {
  const { data: session } = useCurrentSession();
  const canRecord = isBackOfficeRole(session?.user?.role);

  // Only the id is held in state — the row itself is re-derived from the query on every
  // render. Holding the row object instead would freeze the panel's on-hand figure at the
  // value it had when it was clicked, so recording a movement updated the table underneath
  // a header still quoting the old quantity.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    data: products,
    isPending,
    error,
  } = useProducts({ isActive: true, withStock: true, limit: 200 });

  const selected = products?.find((row) => row.id === selectedId) ?? null;

  const columns: Column<StockRow>[] = [
    { key: "sku", header: "SKU", render: (row) => <span className="font-medium">{row.sku}</span> },
    { key: "name", header: "Product", render: (row) => row.name },
    { key: "moq", header: "Minimum", numeric: true, render: (row) => formatNumber(row.moq) },
    {
      key: "onHand",
      header: "On hand",
      numeric: true,
      render: (row) =>
        row.stockOnHand === null ? (
          "—"
        ) : (
          <span className={row.stockOnHand < row.moq ? "font-semibold text-destructive" : undefined}>
            {formatNumber(row.stockOnHand)}
          </span>
        ),
    },
    {
      key: "state",
      header: "State",
      render: (row) =>
        row.stockOnHand === null ? (
          <Badge variant="outline">Unknown</Badge>
        ) : row.stockOnHand < row.moq ? (
          <Badge variant="warning">Below minimum</Badge>
        ) : (
          <Badge variant="success">Stocked</Badge>
        ),
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Inventory"
        description="On-hand quantities are the running total of every stock event — nothing is stored, so nothing can silently disagree."
      />

      {selected ? (
        <StockPanel
          product={selected}
          canRecord={canRecord}
          onClose={() => setSelectedId(null)}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Active products</CardTitle>
          <CardDescription>
            Select a product to record a movement and read its event history.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pt-4 pb-0">
          <DataTable
            columns={columns}
            data={products}
            rowKey={(row) => row.id}
            isLoading={isPending}
            error={error}
            onRowClick={(row) => setSelectedId(row.id)}
            isRowActive={(row) => row.id === selectedId}
            empty={
              <EmptyState
                icon={Boxes}
                title="No active products"
                description="Stock is tracked per product — add a product first and its movements will show up here."
              />
            }
          />
        </CardContent>
      </Card>
    </AppShell>
  );
}

function StockPanel({
  product,
  canRecord,
  onClose,
}: {
  product: StockRow;
  canRecord: boolean;
  onClose: () => void;
}) {
  const { data: history, isPending, error } = useStockHistory(product.id, 20);
  const recordEvent = useRecordInventoryEvent();

  const [eventType, setEventType] = useState<EventType>("RECEIVED");
  const [quantity, setQuantity] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError(null);

    const value = Number(quantity);
    if (!Number.isInteger(value) || value === 0) {
      setValidationError("Quantity must be a whole number, and zero means nothing happened.");
      return;
    }

    try {
      await recordEvent.mutateAsync({
        productId: product.id,
        eventType,
        quantity: value,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      });
      setQuantity("");
      setReference("");
      setNotes("");
    } catch {
      // Rendered below from the mutation's own error state.
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>
            {product.sku} · {product.name}
          </CardTitle>
          <CardDescription>
            {product.stockOnHand === null
              ? "Stock unknown"
              : `${formatNumber(product.stockOnHand)} on hand, minimum order quantity ${formatNumber(product.moq)}`}
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close product" onClick={onClose}>
          <X className="size-4 text-muted-foreground" />
        </Button>
      </CardHeader>

      <CardContent className="grid gap-6 pt-4 lg:grid-cols-2">
        {canRecord ? (
          <form onSubmit={onSubmit} className="space-y-3">
            <h3 className="text-[12px] font-semibold text-secondary-foreground uppercase">
              Record a movement
            </h3>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eventType">Event type</Label>
              <Select
                id="eventType"
                value={eventType}
                onChange={(event) => setEventType(event.target.value as EventType)}
              >
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quantity">Quantity (use negative for reductions)</Label>
              <Input
                id="quantity"
                required
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="-12"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reference">Reference</Label>
              <Input
                id="reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="e.g. order or PO number"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>

            {validationError || recordEvent.error ? (
              <p className="text-[13px] text-destructive">
                {validationError ?? recordEvent.error?.message}
              </p>
            ) : null}

            <Button type="submit" disabled={recordEvent.isPending}>
              {recordEvent.isPending ? "Recording…" : "Record event"}
            </Button>
          </form>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Recording stock movements is a back-office action. You can read the history here.
          </p>
        )}

        <div>
          <h3 className="mb-2 text-[12px] font-semibold text-secondary-foreground uppercase">
            Recent events
          </h3>
          {error ? (
            <p className="text-[13px] text-destructive">{error.message}</p>
          ) : isPending ? (
            <p className="text-[13px] text-muted-foreground">Loading history…</p>
          ) : !history || history.length === 0 ? (
            <EmptyState
              icon={History}
              title="No movements yet"
              description="The first recorded event sets this product's on-hand quantity."
            />
          ) : (
            <ul className="divide-y divide-border text-[13px]">
              {history.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="font-medium">{event.eventType}</div>
                    <div className="text-[12px] text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                      {event.reference ? ` · ${event.reference}` : ""}
                    </div>
                    {event.notes ? (
                      <div className="text-[12px] text-muted-foreground">{event.notes}</div>
                    ) : null}
                  </div>
                  <span
                    className={`tabular-nums ${event.quantity < 0 ? "text-destructive" : "text-foreground"}`}
                  >
                    {event.quantity > 0 ? "+" : ""}
                    {formatNumber(event.quantity)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
