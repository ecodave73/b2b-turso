import { useState } from "react";
import { Info, Trash2, Truck } from "lucide-react";
import { AppShell, isBackOfficeRole } from "../components/app-shell";
import { DataTable, type Column } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { formatCents, parseDollarsToCents } from "../lib/format";
import { useCurrentSession } from "../queries/session";
import { useCreateShippingRate, useDeleteShippingRate, useShippingRates } from "../queries/shipping";

/**
 * Shipping rates. There is NO live carrier integration — the old service carried a
 * "TODO: integrate AusPost and Sendle" and returned the tenant's hand-typed fallback table
 * instead, and that is what was ported. The banner below says so out loud: a quote that looks
 * live but is a manual row is worse for a buyer than an honest one.
 */
type RateRow = {
  id: string;
  carrier: string;
  serviceName: string;
  rateCents: number;
  estimatedDays: string | null;
  isFallback: boolean;
};

export default function Shipping() {
  const { data: session } = useCurrentSession();
  const canEdit = isBackOfficeRole(session?.user?.role);

  const { data: rates, isPending, error } = useShippingRates();
  const deleteRate = useDeleteShippingRate();

  const columns: Column<RateRow>[] = [
    {
      key: "carrier",
      header: "Carrier",
      render: (row) => <span className="font-medium">{row.carrier}</span>,
    },
    { key: "service", header: "Service", render: (row) => row.serviceName },
    { key: "rate", header: "Rate", numeric: true, render: (row) => formatCents(row.rateCents) },
    {
      key: "estimatedDays",
      header: "Estimated delivery",
      render: (row) => <span className="text-muted-foreground">{row.estimatedDays || "—"}</span>,
    },
    {
      key: "fallback",
      header: "Fallback",
      render: (row) =>
        row.isFallback ? <Badge variant="primary">Quoted</Badge> : <Badge variant="outline">Stored</Badge>,
    },
    ...(canEdit
      ? [
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (row: RateRow) => (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${row.carrier} ${row.serviceName}`}
                  disabled={deleteRate.isPending}
                  onClick={() => deleteRate.mutate({ id: row.id })}
                >
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              </div>
            ),
          } satisfies Column<RateRow>,
        ]
      : []),
  ];

  return (
    <AppShell>
      <PageHeader
        title="Shipping"
        description="Your own rate table. Rates marked Quoted are the ones offered to buyers at checkout."
      />

      <div className="mb-4 flex items-start gap-2 rounded-md bg-accent px-4 py-3 text-[13px] text-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          No carrier is ever called. These are rates you type yourself — AusPost and Sendle
          integration was a TODO in the previous system and it is still outstanding, so every quote
          the checkout shows comes from this table.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rates</CardTitle>
          <CardDescription>Sorted by carrier, then cheapest first.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pt-4 pb-0">
          {deleteRate.error ? (
            <p className="px-6 pb-3 text-[13px] text-destructive">{deleteRate.error.message}</p>
          ) : null}
          <DataTable
            columns={columns}
            data={rates}
            rowKey={(row) => row.id}
            isLoading={isPending}
            error={error}
            empty={
              <EmptyState
                icon={Truck}
                title="No shipping rates"
                description="Until a rate exists, checkout has nothing to offer a buyer for delivery."
              />
            }
          />
        </CardContent>
        {canEdit ? <RateForm /> : null}
      </Card>
    </AppShell>
  );
}

function RateForm() {
  const createRate = useCreateShippingRate();
  const [carrier, setCarrier] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [rate, setRate] = useState("");
  const [estimatedDays, setEstimatedDays] = useState("");
  const [isFallback, setIsFallback] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError(null);

    const rateCents = parseDollarsToCents(rate);
    if (rateCents === null || rateCents < 0) {
      setValidationError("Rate must be an amount like 12.95.");
      return;
    }

    try {
      await createRate.mutateAsync({
        carrier: carrier.trim(),
        serviceName: serviceName.trim(),
        rateCents,
        estimatedDays: estimatedDays.trim() || null,
        isFallback,
      });
      setCarrier("");
      setServiceName("");
      setRate("");
      setEstimatedDays("");
    } catch {
      // Surfaced below from the mutation's error state.
    }
  }

  return (
    <div className="border-t border-border px-6 py-5">
      <h3 className="mb-3 text-[12px] font-semibold text-secondary-foreground uppercase">Add a rate</h3>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="carrier">Carrier</Label>
          <Input
            id="carrier"
            required
            value={carrier}
            onChange={(event) => setCarrier(event.target.value)}
            placeholder="e.g. auspost, sendle"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="serviceName">Service</Label>
          <Input
            id="serviceName"
            required
            value={serviceName}
            onChange={(event) => setServiceName(event.target.value)}
            placeholder="e.g. Express Post"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rate">Rate ($)</Label>
          <Input
            id="rate"
            required
            inputMode="decimal"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            placeholder="12.95"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="estimatedDays">Estimated delivery</Label>
          <Input
            id="estimatedDays"
            value={estimatedDays}
            onChange={(event) => setEstimatedDays(event.target.value)}
            placeholder="e.g. 1-2 business days"
          />
        </div>

        <div className="lg:col-span-4">
          <Label htmlFor="isFallback" className="cursor-pointer">
            <input
              id="isFallback"
              type="checkbox"
              aria-label="Offer this rate at checkout"
              checked={isFallback}
              onChange={(event) => setIsFallback(event.target.checked)}
              className="size-4 accent-[#2260F6]"
            />
            Offer this rate at checkout
          </Label>
        </div>

        {validationError || createRate.error ? (
          <p className="text-[13px] text-destructive lg:col-span-4">
            {validationError ?? createRate.error?.message}
          </p>
        ) : null}

        <div className="lg:col-span-4">
          <Button type="submit" disabled={createRate.isPending}>
            {createRate.isPending ? "Adding…" : "Add rate"}
          </Button>
        </div>
      </form>
    </div>
  );
}
