import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loaded by bun test before any test file (see ../../bunfig.toml).
 *
 * The template's database client (`src/api/database/__client.ts`) builds a libsql connection at
 * module-evaluation time, and the guard imports it. Without this, merely importing guard.ts in a
 * test would either crash on an undefined DATABASE_URL or — worse — dial the live Turso database.
 * Pointing it at a throwaway local URL keeps the suite hermetic.
 *
 * WHY A TEMP FILE AND NOT `:memory:`
 * ----------------------------------
 * `@libsql/client` opens a SEPARATE CONNECTION for an interactive transaction. With `:memory:`
 * every connection is its own private, empty database, so `db.transaction(...)` — which is what
 * `withScopedTransaction` runs on — sees no tables at all, and worse, the client keeps the new
 * empty connection afterwards, so every later query fails with `no such table: tenants`. A single
 * transaction silently wiped the whole suite's database. Reproduced directly:
 *
 *   `:memory:`            → in tx: ok; after tx: SQLITE_ERROR: no such table
 *   `file:/tmp/x.db`      → in tx: ok; after tx: ok
 *
 * A per-process temp file is just as hermetic (unique directory, deleted on exit) and, unlike
 * `:memory:`, actually exercises transactions the way Turso will.
 */
const tempDbDir = mkdtempSync(join(tmpdir(), "b2b-test-db-"));
process.env.DATABASE_URL = `file:${join(tempDbDir, "test.db")}`;
delete process.env.DATABASE_AUTH_TOKEN;

process.on("exit", () => {
  rmSync(tempDbDir, { recursive: true, force: true });
});

/**
 * Deterministic auth config. `src/api/auth.ts` reads these at module scope, and `bun test` runs
 * from packages/web where no .env is loaded — so without this, importing the middleware either
 * throws on a missing secret or, if a developer happens to have the real values exported in
 * their shell, quietly points the suite at production identity config. Fixed fakes, always.
 */
process.env.WEBSITE_URL = "http://localhost:4200";
process.env.BETTER_AUTH_SECRET = "test-only-secret-not-used-outside-bun-test";
process.env.APPLICATION_ID = "test-application";
process.env.VITE_RUNABLE_AUTH_ISSUER = "https://auth.invalid";

/**
 * Tenant addressing starts from a known state: no root domain (so the host strategy is inert,
 * exactly as in dev) and no dev-header bypass. Tests that exercise either one set and restore it
 * themselves.
 */
delete process.env.TENANT_ROOT_DOMAIN;
delete process.env.TENANT_DEV_HEADER;
