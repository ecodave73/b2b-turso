import { db } from "../../src/api/database";
import { migrationStatements } from "./db";

/**
 * The MODULE-LEVEL database, migrated.
 *
 * Most of the suite injects its own database (`scopedDb(ctx, db)`), so the module-level client
 * is never queried and preload.ts can leave it as an empty `:memory:` connection. Two things
 * cannot be injected into:
 *
 *   - `tenant/resolve.ts` calls `scopedDb(ctx)` with no explicit client, on purpose: it runs
 *     before any request context exists and takes no database argument.
 *   - Better Auth is constructed once, in `src/api/auth.ts`, against `db`.
 *
 * Testing either one for real means giving that shared connection the actual schema. It stays
 * hermetic — preload.ts pins DATABASE_URL to `:memory:` before anything imports the client, so
 * this is a throwaway in-process database, not Turso.
 *
 * Because it is shared process-wide, tests using it must reset between cases rather than
 * building a fresh instance.
 */

let migrated = false;

export async function migrateModuleDb(): Promise<void> {
  if (migrated) return;
  for (const sql of migrationStatements()) {
    await db.$client.execute(sql);
  }
  migrated = true;
}

/** Every table the migration created, excluding sqlite's own bookkeeping. */
async function tableNames(): Promise<string[]> {
  const result = await db.$client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return result.rows.map((row) => String(row.name));
}

/**
 * Empty every table. Foreign keys are switched off for the duration so the order of the
 * deletes does not matter — the schema declares no cascades (Prisma's `Restrict` default was
 * carried across), so a dependency-ordered teardown would otherwise be required.
 */
export async function resetModuleDb(): Promise<void> {
  await migrateModuleDb();
  await db.$client.execute("PRAGMA foreign_keys = OFF");
  for (const name of await tableNames()) {
    await db.$client.execute(`DELETE FROM "${name}"`);
  }
  await db.$client.execute("PRAGMA foreign_keys = ON");
}

export { db as moduleDb };
