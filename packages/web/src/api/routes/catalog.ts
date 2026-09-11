import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { categories, priceTiers, products } from "../database/schema";
import { authed, requireTenantId, tenantStaff } from "../middleware/auth";
import { stockLevels } from "../services/inventory";

/**
 * Catalogue — the port of src/lib/services/productService.ts plus the category endpoints that
 * lived inline in the old procedures.ts.
 *
 * Named `catalog` rather than `product` because it owns categories too, and because a route
 * file must export its own filename (konsistent `route-files-export-their-feature`) — an
 * export called `products` would collide with the `products` table it imports.
 *
 * Role gating mirrors the old `requireRole` calls one for one: every tenant role may read the
 * catalogue, only the back-office roles may write it.
 *
 * SEARCH IS A LIKE FILTER. The Postgres `searchVector` column was dropped in the port and FTS5
 * lands in phase 6 with the storefront. Nothing here may promise relevance ordering — results
 * come back newest first, not best-match first.
 */

const moneyCents = z.number().int().min(0);

const productFields = {
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullish(),
  unitPriceCents: moneyCents,
  costPriceCents: moneyCents.nullish(),
  /** Basis points: 1000 = 10.00% */
  taxRateBp: z.number().int().min(0).max(10_000),
  moq: z.number().int().min(1),
  weightGrams: z.number().int().min(0).nullish(),
  dimensions: z.string().trim().max(64).nullish(),
  categoryId: z.string().nullish(),
  images: z.array(z.string().url()).max(12).nullish(),
  isActive: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
};

const createInput = z.object({
  ...productFields,
  taxRateBp: productFields.taxRateBp.default(0),
  moq: productFields.moq.default(1),
  isActive: productFields.isActive.default(true),
});

/**
 * Every field optional, so an omitted key is left alone and an explicit null clears it — the
 * contract the old partial update had. Written out rather than derived, because a mapped
 * `Object.fromEntries` over the field map loses its types and would let a typo through.
 */
const updateInput = z.object({
  id: z.string(),
  sku: productFields.sku.optional(),
  name: productFields.name.optional(),
  description: productFields.description.optional(),
  unitPriceCents: productFields.unitPriceCents.optional(),
  costPriceCents: productFields.costPriceCents.optional(),
  taxRateBp: productFields.taxRateBp.optional(),
  moq: productFields.moq.optional(),
  weightGrams: productFields.weightGrams.optional(),
  dimensions: productFields.dimensions.optional(),
  categoryId: productFields.categoryId.optional(),
  images: productFields.images.optional(),
  isActive: productFields.isActive.optional(),
  metadata: productFields.metadata.optional(),
});

export const catalog = {
  list: authed
    .input(
      z
        .object({
          categoryId: z.string().optional(),
          isActive: z.boolean().optional(),
          search: z.string().trim().min(1).max(120).optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
          withStock: z.boolean().default(false),
        })
        .prefault({}),
    )
    .handler(async ({ input, context }) => {
      const filters = [
        input.categoryId ? eq(products.categoryId, input.categoryId) : undefined,
        input.isActive === undefined ? undefined : eq(products.isActive, input.isActive),
        // LIKE, not full text. SQLite LIKE is case-insensitive for ASCII by default.
        input.search ? like(products.name, `%${input.search}%`) : undefined,
      ].filter((clause) => clause !== undefined);

      const rows = await context.db.products.findMany({
        where: filters.length > 0 ? and(...filters) : undefined,
        orderBy: desc(products.createdAt),
        limit: input.limit,
        offset: input.offset,
      });

      const stock = input.withStock
        ? await stockLevels(
            context.db,
            rows.map((row) => row.id),
          )
        : null;

      return rows.map((row) => ({
        id: row.id,
        sku: row.sku,
        name: row.name,
        unitPriceCents: row.unitPriceCents,
        taxRateBp: row.taxRateBp,
        moq: row.moq,
        categoryId: row.categoryId,
        images: row.images ?? [],
        isActive: row.isActive,
        createdAt: row.createdAt,
        stockOnHand: stock ? (stock.get(row.id) ?? 0) : null,
      }));
    }),

  get: authed.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const found = await context.db.products.findById(input.id);
    if (!found) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

    const [category, tiers] = await Promise.all([
      found.categoryId ? context.db.categories.findById(found.categoryId) : Promise.resolve(undefined),
      context.db.priceTiers.findMany({
        where: eq(priceTiers.productId, found.id),
        orderBy: asc(priceTiers.minQty),
      }),
    ]);

    return {
      ...found,
      images: found.images ?? [],
      category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
      priceTiers: tiers.map((tier) => ({
        id: tier.id,
        minQty: tier.minQty,
        maxQty: tier.maxQty,
        unitPriceCents: tier.unitPriceCents,
      })),
    };
  }),

  create: tenantStaff.input(createInput).handler(async ({ input, context }) => {
    const tenantId = requireTenantId(context.ctx);

    const duplicate = await context.db.products.findFirst({ where: eq(products.sku, input.sku) });
    if (duplicate) throw new ORPCError("CONFLICT", { message: `SKU ${input.sku} already exists.` });

    if (input.categoryId) {
      const category = await context.db.categories.findById(input.categoryId);
      if (!category) throw new ORPCError("BAD_REQUEST", { message: "Category not found." });
    }

    const created = await context.db.products.insert({
      tenantId,
      sku: input.sku,
      name: input.name,
      description: input.description ?? null,
      unitPriceCents: input.unitPriceCents,
      costPriceCents: input.costPriceCents ?? null,
      taxRateBp: input.taxRateBp,
      moq: input.moq,
      weightGrams: input.weightGrams ?? null,
      dimensions: input.dimensions ?? null,
      categoryId: input.categoryId ?? null,
      images: input.images ?? [],
      isActive: input.isActive,
      metadata: input.metadata ?? {},
    });

    await context.db.activityLogs.insert({
      tenantId,
      userId: context.user.id,
      action: "product.created",
      entity: "product",
      entityId: created.id,
      details: { sku: created.sku, name: created.name },
    });

    return { id: created.id, sku: created.sku };
  }),

  update: tenantStaff.input(updateInput).handler(async ({ input, context }) => {
    const tenantId = requireTenantId(context.ctx);
    const { id, ...fields } = input;

    const existing = await context.db.products.findById(id);
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

    if (fields.sku !== undefined && fields.sku !== existing.sku) {
      const duplicate = await context.db.products.findFirst({ where: eq(products.sku, fields.sku) });
      if (duplicate) throw new ORPCError("CONFLICT", { message: `SKU ${fields.sku} already exists.` });
    }

    if (fields.categoryId) {
      const category = await context.db.categories.findById(fields.categoryId);
      if (!category) throw new ORPCError("BAD_REQUEST", { message: "Category not found." });
    }

    const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    if (Object.keys(patch).length === 0) return { id };

    await context.db.products.updateById(id, patch);

    await context.db.activityLogs.insert({
      tenantId,
      userId: context.user.id,
      action: "product.updated",
      entity: "product",
      entityId: id,
      details: { fields: Object.keys(patch) },
    });

    return { id };
  }),

  /** Soft delete. Products are referenced by historical orders, so rows are never removed. */
  archive: tenantStaff.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const tenantId = requireTenantId(context.ctx);

    const updated = await context.db.products.updateById(input.id, { isActive: false });
    if (!updated) throw new ORPCError("NOT_FOUND", { message: "Product not found." });

    await context.db.activityLogs.insert({
      tenantId,
      userId: context.user.id,
      action: "product.archived",
      entity: "product",
      entityId: input.id,
      details: { sku: updated.sku },
    });

    return { id: input.id };
  }),

  listCategories: authed.handler(async ({ context }) => {
    const rows = await context.db.categories.findMany({
      orderBy: [asc(categories.sortOrder), asc(categories.name)],
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
    }));
  }),

  createCategory: tenantStaff
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        slug: z
          .string()
          .trim()
          .toLowerCase()
          .min(1)
          .max(120)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens."),
        description: z.string().trim().max(2000).nullish(),
        parentId: z.string().nullish(),
        sortOrder: z.number().int().min(0).default(0),
      }),
    )
    .handler(async ({ input, context }) => {
      const tenantId = requireTenantId(context.ctx);

      const duplicate = await context.db.categories.findFirst({ where: eq(categories.slug, input.slug) });
      if (duplicate) throw new ORPCError("CONFLICT", { message: `Slug ${input.slug} is already used.` });

      const created = await context.db.categories.insert({
        tenantId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder,
      });

      return { id: created.id, slug: created.slug };
    }),
};
