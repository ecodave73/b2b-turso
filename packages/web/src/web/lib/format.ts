/**
 * THE RENDER EDGE.
 *
 * Money is stored and moved as integer cents, tax as basis points, weight as grams — end to
 * end, database to wire. Nothing upstream of a React component may divide by 100. This file
 * is the only place that turns those integers into the strings a human reads, which is why
 * every page imports from here instead of writing `(cents / 100).toFixed(2)` inline.
 */

const currencyFormatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string): Intl.NumberFormat {
  const existing = currencyFormatters.get(currency);
  if (existing) return existing;
  const created = new Intl.NumberFormat("en-AU", { style: "currency", currency });
  currencyFormatters.set(currency, created);
  return created;
}

/** 123456 → "$1,234.56". Integer cents in, never a float. */
export function formatCents(cents: number, currency = "AUD"): string {
  return currencyFormatter(currency).format(cents / 100);
}

/** Compact money for KPI tiles: 123456789 → "$1.23M". */
export function formatCentsCompact(cents: number, currency = "AUD"): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) < 10_000) return formatCents(cents, currency);
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(dollars);
}

/** Basis points → percentage. 1000 → "10.00%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/** Grams → the unit a human would use. 1200 → "1.2 kg", 850 → "850 g". */
export function formatGrams(grams: number | null | undefined): string {
  if (grams === null || grams === undefined) return "—";
  if (grams >= 1000) return `${(grams / 1000).toLocaleString("en-AU", { maximumFractionDigits: 2 })} kg`;
  return `${grams.toLocaleString("en-AU")} g`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-AU");
}

export function formatDate(value: Date | string | number): string {
  return new Date(value).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: Date | string | number): string {
  return new Date(value).toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Parses a typed dollar amount into integer cents. Returns null for anything unparseable. */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/[$,]/g, "");
  if (!trimmed || !/^-?\d*(\.\d{0,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Parses a typed percentage into basis points. "10" and "10.5" → 1000 and 1050. */
export function parsePercentToBp(input: string): number | null {
  const trimmed = input.trim().replace("%", "");
  if (!trimmed || !/^\d*(\.\d{0,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * "1 tenant" / "2 tenants". Counts are rendered next to their noun all over the admin, and
 * an unagreed "1 users" reads like a bug even when the number is right.
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
