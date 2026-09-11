import { useState } from "react";
import { Calculator, Layers, Trash2 } from "lucide-react";
import { AppShell, isBackOfficeRole } from "../components/app-shell";
import { DataTable, type Column } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { formatBp, formatCents, formatNumber, parseDollarsToCents } from "../lib/format";
import { useProducts } from "../queries/catalog";
import {
  useCreatePriceTier,
  useDeletePriceTier,
  usePriceQuote,
  usePriceTiers,
} from "../queries/pricing";
import { useCurrentSession } from "../queries/session";

/**
 * Volume pricing. Tiers are per product and must not overlap — the server refuses an
 * overlapping range with CONFLICT rather than resolving it at read time, so the message it
 * returns is surfaced verbatim instead of being flattened into "something went wrong".
 *
 * The calculator calls the same `pricing.quote` the cart and order creation price with, so the
 * number here is the number that gets charged, MOQ refusals included.
 */
type TierRow = {
  id: string;
  minQty: number;
  maxQty: number | null;
  unitPriceCents: number;
};

export default function Pricing() {
  const { data: session } = useCurrentSession();
  const canEdit = isBackOfficeRole(session?.user?.role);

  const [productId, setProductId] = useState("");
  const { data: products, isPending: productsPending } = useProducts({
    isActive: true,
    limit: 200,
  });

  const { data: tiers, isPending, error } = usePriceTiers(productId || null);
  const deleteTier = useDeletePriceTier();

  const product = products?.find((row) => row.id === productId);

  const columns: Column<TierRow>[] = [
    { key: "minQty", header: "From qty", numeric: true, render: (row) => formatNumber(row.minQty) },
    {
      key: "maxQty",
      header: "To qty",
      numeric: true,
      render: (row) => (row.maxQty === null ? "Unlimited" : formatNumber(row.maxQty)),
    },
    {
      key: "unitPrice",
      header: "Unit price",
      numeric: true,
      render: (row) => formatCents(row.unitPriceCents),
    },
    ...(canEdit
      ? [
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (row: TierRow) => (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete tier from ${row.minQty}`}
                  disabled={deleteTier.isPending}
                  onClick={() => deleteTier.mutate({ id: row.id })}
                >
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              </div>
            ),
          } satisfies Column<TierRow>,
        ]
      : []),
  ];

  return (
    <AppShell>
      <PageHeader
        title="Pricing"
        description="Volume breaks per product. The deepest tier a quantity qualifies for wins; overlapping ranges are refused."
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Product</CardTitle>
          <CardDescription>
            {product
              ? `Base price ${formatCents(product.unitPriceCents)} · tax ${formatBp(product.taxRateBp)} · minimum ${formatNumber(product.moq)}`
              : "Choose a product to see and edit its price tiers."}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="sm:max-w-[420px]">
            <Select
              value={productId}
              aria-label="Choose a product"
              disabled={productsPending}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="">Select a product…</option>
              {(products ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.sku} — {row.name}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      {productId ? (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Price tiers</CardTitle>
              <CardDescription>Ranges are inclusive and may not overlap each other.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pt-4 pb-0">
              {deleteTier.error ? (
                <p className="px-6 pb-3 text-[13px] text-destructive">{deleteTier.error.message}</p>
              ) : null}
              <DataTable
                columns={columns}
                data={tiers}
                rowKey={(row) => row.id}
                isLoading={isPending}
                error={error}
                empty={
                  <EmptyState
                    icon={Layers}
                    title="No volume breaks"
                    description="Without a tier, every quantity is quoted at the product's base price."
                  />
                }
              />
            </CardContent>
            {canEdit ? <TierForm productId={productId} /> : null}
          </Card>

          <QuoteCalculator productId={productId} />
        </div>
      ) : null}
    </AppShell>
  );
}

function TierForm({ productId }: { productId: string }) {
  const createTier = useCreatePriceTier();
  const [minQty, setMinQty] = useState("");
  const [maxQty, setMaxQty] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError(null);

    const min = Number(minQty);
    if (!Number.isInteger(min) || min < 1) {
      setValidationError("The lower bound must be a whole number of at least 1.");
      return;
    }
    const max = maxQty.trim() ? Number(maxQty) : null;
    if (max !== null && (!Number.isInteger(max) || max < min)) {
      setValidationError("The upper bound must be a whole number no smaller than the lower bound.");
      return;
    }
    const unitPriceCents = parseDollarsToCents(unitPrice);
    if (unitPriceCents === null || unitPriceCents < 0) {
      setValidationError("Unit price must be an amount like 9.50.");
      return;
    }

    try {
      await createTier.mutateAsync({ productId, minQty: min, maxQty: max, unitPriceCents });
      setMinQty("");
      setMaxQty("");
      setUnitPrice("");
    } catch {
      // Surfaced below — an overlap comes back as a CONFLICT with a readable message.
    }
  }

  return (
    <div className="border-t border-border px-6 py-5">
      <h3 className="mb-3 text-[12px] font-semibold text-secondary-foreground uppercase">Add a tier</h3>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="minQty">From quantity</Label>
          <Input
            id="minQty"
            required
            inputMode="numeric"
            value={minQty}
            onChange={(event) => setMinQty(event.target.value)}
            placeholder="50"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="maxQty">To quantity</Label>
          <Input
            id="maxQty"
            inputMode="numeric"
            value={maxQty}
            onChange={(event) => setMaxQty(event.target.value)}
            placeholder="Leave empty for unlimited"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tierUnitPrice">Unit price ($)</Label>
          <Input
            id="tierUnitPrice"
            required
            inputMode="decimal"
            value={unitPrice}
            onChange={(event) => setUnitPrice(event.target.value)}
            placeholder="9.50"
          />
        </div>

        {validationError || createTier.error ? (
          <p className="text-[13px] text-destructive sm:col-span-3">
            {validationError ?? createTier.error?.message}
          </p>
        ) : null}

        <div className="sm:col-span-3">
          <Button type="submit" disabled={createTier.isPending}>
            {createTier.isPending ? "Adding…" : "Add tier"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function QuoteCalculator({ productId }: { productId: string }) {
  const [quantityInput, setQuantityInput] = useState("1");
  const quantity = Number(quantityInput);
  const valid = Number.isInteger(quantity) && quantity > 0;

  const { data: quote, isFetching, error } = usePriceQuote(productId, valid ? quantity : 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>What does it cost?</CardTitle>
        <CardDescription>
          The same quote the cart and order creation use — including the minimum-order refusal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quoteQty">Quantity</Label>
          <Input
            id="quoteQty"
            inputMode="numeric"
            value={quantityInput}
            onChange={(event) => setQuantityInput(event.target.value)}
          />
        </div>

        {!valid ? (
          <p className="text-[13px] text-muted-foreground">Enter a whole quantity of at least 1.</p>
        ) : error ? (
          <p className="text-[13px] text-destructive">{error.message}</p>
        ) : isFetching || !quote ? (
          <p className="text-[13px] text-muted-foreground">Pricing…</p>
        ) : (
          <dl className="space-y-1 text-[13px]">
            <QuoteRow label="Unit price" value={formatCents(quote.unitPriceCents)} />
            <QuoteRow label="Tier applied" value={quote.tierApplied ?? "Base price"} />
            <QuoteRow label="Line total" value={formatCents(quote.totalPriceCents)} />
            <QuoteRow label={`Tax (${formatBp(quote.taxRateBp)})`} value={formatCents(quote.taxCents)} />
            <QuoteRow label="Total inc. tax" value={formatCents(quote.totalIncTaxCents)} emphasis />
          </dl>
        )}

        <p className="flex items-start gap-2 text-[12px] text-muted-foreground">
          <Calculator className="mt-0.5 size-3.5 shrink-0" />
          Quotes are computed server-side. A quantity below the product's minimum is refused here
          exactly as it would be at checkout.
        </p>
      </CardContent>
    </Card>
  );
}

function QuoteRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${emphasis ? "font-semibold text-foreground" : ""}`}>
      <dt className={emphasis ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
