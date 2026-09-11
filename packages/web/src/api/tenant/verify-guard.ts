/**
 * Guard verifier — the structural stand-in for `FORCE ROW LEVEL SECURITY`.
 *
 * The old Postgres build had `npm run rls:verify` assert that every table had RLS enabled and
 * forced. There is no database-side equivalent on Turso, so this asserts the *only* thing that
 * still holds the line: that application code cannot reach the database except through the
 * guard, and that every tenant-scoped table is actually guarded.
 *
 * Run with `bun run guard:verify`. Exits non-zero on any failure, so it can gate the build.
 */
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../database/schema";
import { TENANT_SCOPED_TABLES } from "../database/schema";
import { ANONYMOUS_CONTEXT, type RequestContext } from "./context";
import { scopedDb, TENANT_DELETE_ORDER } from "./guard";

const WEB_ROOT = new URL("../../../", import.meta.url).pathname;

/** Only these files may import the raw Drizzle client. Everything else uses scopedDb(). */
const CLIENT_IMPORT_ALLOWLIST = [
  "src/api/database/index.ts",
  "src/api/database/__client.ts",
  "src/api/tenant/guard.ts",
  // PHASE 2 — the second deliberate hole, and the last one. Better Auth writes the user row at
  // signup, before the caller belongs to any tenant, and owns session/account/verification,
  // which are not tenant-scoped at all. It cannot go through scopedDb. The scope of the hole:
  // auth may create and read user rows. Nothing in src/api/auth.ts queries a tenant table.
  "src/api/auth.ts",
];

/**
 * Tables intentionally outside TENANT_SCOPED_TABLES. Each is handled explicitly in guard.ts;
 * anything else carrying a tenantId column must be registered or this verifier fails.
 */
const UNREGISTERED_BY_DESIGN = new Set(["order_line_items", "tenants", "users"]);

const failures: string[] = [];
const checks: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    checks.push(name);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
  }
}

// ---------------------------------------------------------------------------
// 1. No application file may import the raw Drizzle client.
// ---------------------------------------------------------------------------
const CLIENT_IMPORT = /from\s+["'][^"']*(?:api\/database|\.\.\/database|\.\/database|__client)["']/;

const offenders: string[] = [];
const glob = new Glob("src/**/*.{ts,tsx}");
for await (const file of glob.scan({ cwd: WEB_ROOT })) {
  if (CLIENT_IMPORT_ALLOWLIST.includes(file)) continue;
  const source = await Bun.file(`${WEB_ROOT}${file}`).text();
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
    if (CLIENT_IMPORT.test(line)) offenders.push(`${file}: ${line.trim()}`);
  }
}
check(
  "raw Drizzle client is imported only by the guard",
  offenders.length === 0,
  offenders.length > 0 ? `use scopedDb() instead:\n    ${offenders.join("\n    ")}` : undefined,
);

// ---------------------------------------------------------------------------
// 2. Every registered table really has a tenantId column.
// ---------------------------------------------------------------------------
for (const [name, table] of Object.entries(TENANT_SCOPED_TABLES)) {
  const columns = getTableColumns(table as SQLiteTable);
  check(`${name} has a tenantId column`, "tenantId" in columns, `TENANT_SCOPED_TABLES."${name}" cannot be filtered`);
}

// ---------------------------------------------------------------------------
// 3. Every schema table carrying tenantId is registered (or a documented exception).
// ---------------------------------------------------------------------------
const registered = new Set(Object.values(TENANT_SCOPED_TABLES).map((t) => getTableName(t as SQLiteTable)));
for (const exported of Object.values(schema)) {
  if (!isTable(exported)) continue;
  const table = exported as SQLiteTable;
  const tableName = getTableName(table);
  if (registered.has(tableName) || UNREGISTERED_BY_DESIGN.has(tableName)) continue;
  const columns = getTableColumns(table);
  check(
    `${tableName} is registered in TENANT_SCOPED_TABLES`,
    !("tenantId" in columns),
    `it has a tenantId column but no guard entry — add it to TENANT_SCOPED_TABLES`,
  );
}

// ---------------------------------------------------------------------------
// 4. Every registered table gets a helper, and every helper carries a scope predicate.
// ---------------------------------------------------------------------------
const tenantCtx: RequestContext = { userId: "verifier", tenantId: "verifier-tenant", role: "TENANT_ADMIN" };
const scoped = scopedDb(tenantCtx) as unknown as Record<string, { scope?: unknown } | undefined>;

for (const name of [...Object.keys(TENANT_SCOPED_TABLES), "orderLineItems", "tenants", "users"]) {
  const helper = scoped[name];
  check(`scopedDb exposes ${name}`, Boolean(helper), `no guarded helper for "${name}"`);
  check(`scopedDb.${name} injects a scope predicate`, Boolean(helper?.scope), `"${name}" would query unfiltered`);
}

// ---------------------------------------------------------------------------
// 5. Fail closed: no tenant and no super-admin role must match nothing.
// ---------------------------------------------------------------------------
const anon = scopedDb(ANONYMOUS_CONTEXT) as unknown as Record<string, { scope?: { queryChunks?: unknown[] } }>;
for (const name of Object.keys(TENANT_SCOPED_TABLES)) {
  const rendered = JSON.stringify(anon[name]?.scope?.queryChunks ?? []);
  check(
    `scopedDb.${name} fails closed without a tenant`,
    rendered.includes("1 = 0"),
    "an unresolved request would see every tenant's rows",
  );
}

// ---------------------------------------------------------------------------
// 6. The tenant-resolution seam stays a seam.
//
// resolve.ts is the ONLY place allowed to turn a Host header, a URL path or a dev header into a
// tenant. That single choke point is what lets real `{subdomain}.host` routing be switched on at
// deploy by setting TENANT_ROOT_DOMAIN, without touching a route, a service or a component.
//
// The UI phases are where this discipline erodes: a dashboard component "just checking
// window.location" for a quick fix forks tenant addressing away from the seam, and the fork keeps
// working in dev on the /t/ prefix so nothing looks broken until the deploy switch silently only
// half-applies. Grepped, not trusted.
// ---------------------------------------------------------------------------
const SEAM_ALLOWLIST = new Set([
  "src/api/tenant/resolve.ts", // the seam itself
  "src/api/tenant/verify-guard.ts", // this file names the patterns it forbids
  "src/web/lib/api.ts", // forwards window.location.pathname as TENANT_PATH_HEADER
  "src/web/app.tsx", // tenantBase() mirrors the seam to set the Wouter router base
]);

const SEAM_PATTERNS: Array<[RegExp, string]> = [
  [/location\.(host|hostname)\b/, "reads the Host/hostname directly"],
  [/location\.pathname\b/, "parses the URL path for a tenant"],
  [/["'`]x-tenant-(subdomain|path)["'`]/, "hardcodes a tenant header name"],
  [/\bsubdomainFrom(Host|Path)\s*\(/, "calls a seam internal, bypassing the strategy ordering"],
];

const seamViolations: string[] = [];
for (const file of new Glob("src/**/*.{ts,tsx}").scanSync({ cwd: WEB_ROOT })) {
  const relative = file.split("\\").join("/");
  if (SEAM_ALLOWLIST.has(relative)) continue;
  if (relative.split("/").some((segment) => segment.startsWith("__"))) continue; // template-managed
  const source = readFileSync(`${WEB_ROOT}${relative}`, "utf8");
  for (const [pattern, reason] of SEAM_PATTERNS) {
    if (pattern.test(source)) seamViolations.push(`${relative} ${reason}`);
  }
}
check(
  "tenant addressing goes through resolve.ts only",
  seamViolations.length === 0,
  `outside the seam: ${seamViolations.join("; ")}. Use the resolved tenant from context instead.`,
);

// ---------------------------------------------------------------------------
// 7. Deleting a tenant cannot leave orphans.
//
// deleteTenantCascade() removes a tenant's rows in an explicit child-before-parent order. If a
// new tenant-scoped table is registered and nobody adds it to that order, the delete would
// succeed while leaving rows behind that carry a dead tenantId — invisible, un-queryable through
// the guard, and still holding customer data. So the two lists must stay in step.
// ---------------------------------------------------------------------------
const deleteOrder = new Set<string>(TENANT_DELETE_ORDER);
for (const name of Object.keys(TENANT_SCOPED_TABLES)) {
  check(
    `TENANT_DELETE_ORDER covers ${name}`,
    deleteOrder.has(name),
    `deleting a tenant would orphan every "${name}" row — add it to TENANT_DELETE_ORDER in guard.ts`,
  );
}
for (const name of deleteOrder) {
  check(
    `TENANT_DELETE_ORDER."${name}" is still a registered table`,
    name in TENANT_SCOPED_TABLES,
    `"${name}" is in the delete order but no longer tenant-scoped`,
  );
}

// ---------------------------------------------------------------------------

console.log(`guard:verify — ${checks.length} checks passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("Tenant guard intact.");
