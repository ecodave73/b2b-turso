import { ORPCError } from "@orpc/server";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { priceTiers, products } from "../database/schema";
import type { ScopedDb } from "../tenant/guard";

/**
 * Volume pricing — the port of the old src/lib/services/pricingService.ts.
 *
 * Shared by the pricing route and the cart, so the price a buyer is quoted and the price they
 * are charged come from the same function. In the old stack cartService kept its own copy of
 * this logic (`getEffectivePunitPrice`) which had already drifted: it filtered price tiers by
 * `tenantId` while pricingService did not, and it required `isActive` while pricingService did
 * not. One implementation now, with the stricter of the two behaviours.
 *
 * MONEY IS CENTS. `unitPriceCents` in, `unitPriceCents` out — no floats anywhere on this path.
 */

export interface EffectivePrice {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  /** e.g. "50+" when a volume tier applied, null when the base price did. */
  tierApplied: string | null;
  moq: number;
  taxRateBp: number;
}

type PricedProduct = {
  id: string;
  unitPriceCents: number;
  moq: number;
  taxRateBp: number;
  isActive: boolean;
};

/** Loads a product for pricing, refusing anything the buyer cannot legitimately order. */
export async function loadPricedProduct(
  db: ScopedDb,
  productId: string,
  options: { requireActive?: boolean } = {},
): Promise<PricedProduct> {
  const product = await db.products.findById(productId);
  if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found." });
  if (options.requireActive && !product.isActive) {
    throw new ORPCError("NOT_FOUND", { message: "Product is not available." });
  }
  return {
    id: product.id,
    unitPriceCents: product.unitPriceCents,
    moq: product.moq,
    taxRateBp: product.taxRateBp,
    isActive: product.isActive,
  };
}

/**
 * The effective unit price for a quantity: the deepest volume tier whose range contains it,
 * else the product's base price. Enforces MOQ, exactly as the old service did.
 */
export async function effectivePrice(
  db: ScopedDb,
  productId: string,
  quantity: number,
  options: { requireActive?: boolean } = {},
): Promise<EffectivePrice> {
  const product = await loadPricedProduct(db, productId, options);

  if (quantity < product.moq) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Minimum order quantity for this product is ${product.moq}.`,
    });
  }

  const tier = await db.priceTiers.findFirst({
    where: and(
      eq(priceTiers.productId, productId),
      lte(priceTiers.minQty, quantity),
      or(isNull(priceTiers.maxQty), gte(priceTiers.maxQty, quantity)),
    ),
    orderBy: desc(priceTiers.minQty),
  });

  const unitPriceCents = tier ? tier.unitPriceCents : product.unitPriceCents;

  return {
    productId,
    quantity,
    unitPriceCents,
    totalPriceCents: unitPriceCents * quantity,
    tierApplied: tier ? `${tier.minQty}+` : null,
    moq: product.moq,
    taxRateBp: product.taxRateBp,
  };
}

/** Tax on a line, in cents. Basis points, integer-rounded — never a float multiplication. */
export function taxCents(lineTotalCents: number, taxRateBp: number): number {
  return Math.round((lineTotalCents * taxRateBp) / 10_000);
}

/** Guards a productId belongs to the caller's tenant before it is referenced elsewhere. */
export async function assertProductInScope(db: ScopedDb, productId: string): Promise<void> {
  const rows = await db.products.findMany({ where: eq(products.id, productId), limit: 1 });
  if (rows.length === 0) throw new ORPCError("NOT_FOUND", { message: "Product not found." });
}
