import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import { Archive, Package, Pencil, Plus, X } from "lucide-react";
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
import { formatBp, formatCents, formatNumber, parseDollarsToCents, parsePercentToBp } from "../lib/format";
import {
  useArchiveProduct,
  useCategories,
  useCreateProduct,
  useProducts,
  useUpdateProduct,
} from "../queries/catalog";
import { useCurrentSession } from "../queries/session";

/**
 * The catalogue. Back-office roles get the editor; a buyer gets the same table read-only, which
 * is exactly the split the server enforces (catalog.list is `authed`, every write is
 * `tenantStaff`) — the UI is not the thing keeping a buyer out.
 *
 * The top bar's search box navigates here with ?q=…; that value seeds the filter below rather
 * than being ignored, so the search is real. It is a LIKE match with no relevance ordering —
 * rows come back newest first (FTS5 is phase 6) — and the caption says so.
 */
type ProductRow = {
  id: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  taxRateBp: number;
  moq: number;
  categoryId: string | null;
  isActive: boolean;
  stockOnHand: number | null;
};

const EMPTY_FORM = {
  id: null as string | null,
  sku: "",
  name: "",
  description: "",
  unitPrice: "",
  costPrice: "",
  taxRate: "",
  moq: "1",
  weightGrams: "",
  dimensions: "",
  categoryId: "",
  images: "",
  isActive: true,
};

type FormState = typeof EMPTY_FORM;

export default function Products() {
  const { data: session } = useCurrentSession();
  const canEdit = isBackOfficeRole(session?.user?.role);

  const searchString = useSearch();
  const initialQuery = useMemo(() => new URLSearchParams(searchString).get("q") ?? "", [searchString]);

  const [search, setSearch] = useState(initialQuery);
  const [categoryId, setCategoryId] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "archived">("active");
  const [form, setForm] = useState<FormState | null>(null);

  // The shell can navigate here again with a different ?q= while this page is already mounted.
  useEffect(() => setSearch(initialQuery), [initialQuery]);

  const { data: categories } = useCategories();
  const {
    data: products,
    isPending,
    error,
  } = useProducts({
    search: search.trim() || undefined,
    categoryId: categoryId || undefined,
    isActive: activeFilter === "all" ? undefined : activeFilter === "active",
    withStock: true,
    limit: 200,
  });

  const categoryName = (id: string | null) =>
    id ? (categories?.find((category) => category.id === id)?.name ?? "—") : "—";

  const archiveProduct = useArchiveProduct();

  const columns: Column<ProductRow>[] = [
    { key: "sku", header: "SKU", render: (row) => <span className="font-medium">{row.sku}</span> },
    { key: "name", header: "Product", render: (row) => row.name },
    {
      key: "category",
      header: "Category",
      render: (row) => <span className="text-muted-foreground">{categoryName(row.categoryId)}</span>,
    },
    {
      key: "price",
      header: "Unit price",
      numeric: true,
      render: (row) => formatCents(row.unitPriceCents),
    },
    {
      key: "tax",
      header: "Tax",
      numeric: true,
      render: (row) => <span className="text-muted-foreground">{formatBp(row.taxRateBp)}</span>,
    },
    { key: "moq", header: "MOQ", numeric: true, render: (row) => formatNumber(row.moq) },
    {
      key: "stock",
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
      key: "status",
      header: "Status",
      render: (row) =>
        row.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Archived</Badge>,
    },
    ...(canEdit
      ? [
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (row: ProductRow) => (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${row.sku}`}
                  onClick={() => setForm(formFromRow(row))}
                >
                  <Pencil className="size-4 text-muted-foreground" />
                </Button>
                {row.isActive ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Archive ${row.sku}`}
                    disabled={archiveProduct.isPending}
                    onClick={() => archiveProduct.mutate({ id: row.id })}
                  >
                    <Archive className="size-4 text-muted-foreground" />
                  </Button>
                ) : null}
              </div>
            ),
          } satisfies Column<ProductRow>,
        ]
      : []),
  ];

  return (
    <AppShell>
      <PageHeader
        title="Products"
        description="Your catalogue: prices in cents, tax in basis points, stock derived from the event log."
        actions={
          canEdit ? (
            <Button onClick={() => setForm({ ...EMPTY_FORM })}>
              <Plus className="size-4" />
              New product
            </Button>
          ) : null
        }
      />

      {form && canEdit ? (
        <ProductForm form={form} setForm={setForm} categories={categories ?? []} onClose={() => setForm(null)} />
      ) : null}

      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle>Catalogue</CardTitle>
            <CardDescription>
              Search matches product names (substring match, newest first — not ranked).
            </CardDescription>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search products…"
              aria-label="Search products"
            />
            <Select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {(categories ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
            <Select
              value={activeFilter}
              onChange={(event) => setActiveFilter(event.target.value as typeof activeFilter)}
              aria-label="Filter by status"
            >
              <option value="active">Active only</option>
              <option value="archived">Archived only</option>
              <option value="all">All statuses</option>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="px-0 pt-4 pb-0">
          {archiveProduct.error ? (
            <p className="px-6 pb-3 text-[13px] text-destructive">{archiveProduct.error.message}</p>
          ) : null}
          <DataTable
            columns={columns}
            data={products}
            rowKey={(row) => row.id}
            isLoading={isPending}
            error={error}
            empty={
              <EmptyState
                icon={Package}
                title={search ? "Nothing matches that search" : "No products yet"}
                description={
                  search
                    ? "Try a shorter term — this is a substring match on the product name."
                    : "Add your first product to start quoting prices and tracking stock."
                }
                action={
                  canEdit && !search ? (
                    <Button onClick={() => setForm({ ...EMPTY_FORM })}>
                      <Plus className="size-4" />
                      New product
                    </Button>
                  ) : null
                }
              />
            }
          />
        </CardContent>
      </Card>
    </AppShell>
  );
}

function formFromRow(row: ProductRow): FormState {
  return {
    ...EMPTY_FORM,
    id: row.id,
    sku: row.sku,
    name: row.name,
    unitPrice: (row.unitPriceCents / 100).toFixed(2),
    taxRate: (row.taxRateBp / 100).toFixed(2),
    moq: String(row.moq),
    categoryId: row.categoryId ?? "",
    isActive: row.isActive,
  };
}

function ProductForm({
  form,
  setForm,
  categories,
  onClose,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
  categories: { id: string; name: string }[];
  onClose: () => void;
}) {
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const [validationError, setValidationError] = useState<string | null>(null);

  const editing = !!form.id;
  const pending = createProduct.isPending || updateProduct.isPending;
  const serverError = createProduct.error ?? updateProduct.error;

  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError(null);

    // Money and tax are parsed at the edge and travel as integers from here on — nothing
    // downstream of this function sees a dollar string or a float.
    const unitPriceCents = parseDollarsToCents(form.unitPrice);
    if (unitPriceCents === null || unitPriceCents < 0) {
      setValidationError("Unit price must be an amount like 12.50.");
      return;
    }
    const costPriceCents = form.costPrice.trim() ? parseDollarsToCents(form.costPrice) : null;
    if (form.costPrice.trim() && costPriceCents === null) {
      setValidationError("Cost price must be an amount like 8.00.");
      return;
    }
    const taxRateBp = form.taxRate.trim() ? parsePercentToBp(form.taxRate) : 0;
    if (taxRateBp === null || taxRateBp > 10_000) {
      setValidationError("Tax rate must be a percentage between 0 and 100.");
      return;
    }
    const moq = Number(form.moq);
    if (!Number.isInteger(moq) || moq < 1) {
      setValidationError("Minimum order quantity must be a whole number of at least 1.");
      return;
    }
    const weightGrams = form.weightGrams.trim() ? Number(form.weightGrams) : null;
    if (weightGrams !== null && (!Number.isInteger(weightGrams) || weightGrams < 0)) {
      setValidationError("Weight must be a whole number of grams.");
      return;
    }
    const images = form.images
      .split(/\s*[\n,]\s*/)
      .map((url) => url.trim())
      .filter(Boolean);

    const payload = {
      sku: form.sku.trim(),
      name: form.name.trim(),
      description: form.description.trim() || null,
      unitPriceCents,
      costPriceCents,
      taxRateBp,
      moq,
      weightGrams,
      dimensions: form.dimensions.trim() || null,
      categoryId: form.categoryId || null,
      images,
      isActive: form.isActive,
    };

    try {
      if (form.id) {
        await updateProduct.mutateAsync({ id: form.id, ...payload });
      } else {
        await createProduct.mutateAsync(payload);
      }
      onClose();
    } catch {
      // Surfaced below through the mutation's own error state (duplicate SKU, bad category…).
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>{editing ? `Edit ${form.sku}` : "New product"}</CardTitle>
          <CardDescription>
            {editing ? "Only the fields you change are written." : "SKU must be unique within your workspace."}
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close form" onClick={onClose}>
          <X className="size-4 text-muted-foreground" />
        </Button>
      </CardHeader>
      <CardContent className="pt-4">
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
          <Field label="SKU" htmlFor="sku">
            <Input
              id="sku"
              required
              value={form.sku}
              onChange={(event) => set({ sku: event.target.value })}
              placeholder="ABC-001"
            />
          </Field>
          <Field label="Name" htmlFor="name">
            <Input
              id="name"
              required
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </Field>
          <Field label="Description" htmlFor="description" className="sm:col-span-2">
            <Textarea
              id="description"
              value={form.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </Field>
          <Field label="Unit price ($)" htmlFor="unitPrice">
            <Input
              id="unitPrice"
              required
              inputMode="decimal"
              value={form.unitPrice}
              onChange={(event) => set({ unitPrice: event.target.value })}
              placeholder="12.50"
            />
          </Field>
          <Field label="Cost price ($)" htmlFor="costPrice">
            <Input
              id="costPrice"
              inputMode="decimal"
              value={form.costPrice}
              onChange={(event) => set({ costPrice: event.target.value })}
              placeholder="Optional"
            />
          </Field>
          <Field label="Tax rate (%)" htmlFor="taxRate">
            <Input
              id="taxRate"
              inputMode="decimal"
              value={form.taxRate}
              onChange={(event) => set({ taxRate: event.target.value })}
              placeholder="10"
            />
          </Field>
          <Field label="Minimum order qty" htmlFor="moq">
            <Input
              id="moq"
              inputMode="numeric"
              value={form.moq}
              onChange={(event) => set({ moq: event.target.value })}
            />
          </Field>
          <Field label="Weight (g)" htmlFor="weightGrams">
            <Input
              id="weightGrams"
              inputMode="numeric"
              value={form.weightGrams}
              onChange={(event) => set({ weightGrams: event.target.value })}
              placeholder="Optional"
            />
          </Field>
          <Field label="Dimensions" htmlFor="dimensions">
            <Input
              id="dimensions"
              value={form.dimensions}
              onChange={(event) => set({ dimensions: event.target.value })}
              placeholder="L x W x H cm"
            />
          </Field>
          <Field label="Category" htmlFor="categoryId">
            <Select
              id="categoryId"
              value={form.categoryId}
              onChange={(event) => set({ categoryId: event.target.value })}
            >
              <option value="">Uncategorised</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Image URLs (one per line)" htmlFor="images">
            <Textarea
              id="images"
              value={form.images}
              onChange={(event) => set({ images: event.target.value })}
              placeholder="https://…"
            />
          </Field>

          <div className="sm:col-span-2">
            <Label htmlFor="isActive" className="cursor-pointer">
              <input
                id="isActive"
                type="checkbox"
                aria-label="Active — listed in the catalogue and orderable"
                checked={form.isActive}
                onChange={(event) => set({ isActive: event.target.checked })}
                className="size-4 accent-[#2260F6]"
              />
              Active — listed in the catalogue and orderable
            </Label>
          </div>

          {validationError || serverError ? (
            <p className="text-[13px] text-destructive sm:col-span-2">
              {validationError ?? serverError?.message}
            </p>
          ) : null}

          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Create product"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
