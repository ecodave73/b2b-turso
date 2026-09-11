/**
 * Migration-drift verifier — makes the `db:push` footgun impossible to forget.
 *
 * `drizzle-kit push` writes straight to Turso and does NOT touch `drizzle/*.sql`. But
 * `tests/helpers/db.ts` builds its in-memory database *from* those files, so a push without a
 * matching `generate` silently drifts the test database from the real one. That is exactly how
 * phase 2 ended up at 84 fail / 0 pass with a schema change that worked perfectly against
 * Turso — the kind of failure that looks like the tests were never run.
 *
 * Two defences, because a documented rule gets violated the first time someone is in a hurry:
 *   1. `db:push` now chains `db:generate`, so the drift cannot be created by the normal path.
 *   2. This script gates the build for every other path (hand-edited schema, a merge, a
 *      `drizzle-kit push` typed directly into a shell).
 *
 * How it works: snapshot `drizzle/`, run `drizzle-kit generate`, and see whether it had anything
 * new to say. If it emitted a migration, the committed SQL did not describe the schema and the
 * check fails. The snapshot is restored either way, so running this never mutates the repo.
 *
 * Run with `bun run db:verify`. Exits non-zero on drift.
 */
import { readdirSync, rmSync, cpSync, existsSync } from "node:fs";

const WEB_ROOT = new URL("../../../", import.meta.url).pathname;
const DRIZZLE_DIR = `${WEB_ROOT}drizzle`;
const SNAPSHOT_DIR = `${WEB_ROOT}.drizzle-drift-snapshot`;

function migrations(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

if (!existsSync(DRIZZLE_DIR)) {
  console.error("db:verify — no drizzle/ directory. Run `bun run db:generate` first.");
  process.exit(1);
}

const before = migrations(DRIZZLE_DIR);

rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
cpSync(DRIZZLE_DIR, SNAPSHOT_DIR, { recursive: true });

let generated: { exitCode: number; stderr: string };
try {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--env-file=../../.env", "drizzle-kit", "generate"],
    cwd: WEB_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  generated = { exitCode: proc.exitCode, stderr: new TextDecoder().decode(proc.stderr) };
} finally {
  // Restore unconditionally: this check is a read, not a write.
  const after = migrations(DRIZZLE_DIR);
  const added = after.filter((file) => !before.includes(file));
  rmSync(DRIZZLE_DIR, { recursive: true, force: true });
  cpSync(SNAPSHOT_DIR, DRIZZLE_DIR, { recursive: true });
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });

  if (generated.exitCode !== 0) {
    console.error("db:verify — drizzle-kit generate failed:\n");
    console.error(generated.stderr.trim());
    process.exit(1);
  }

  if (added.length > 0) {
    console.error(
      [
        "",
        "db:verify — MIGRATION DRIFT.",
        "",
        `drizzle-kit generate wanted to write: ${added.join(", ")}`,
        "",
        "The schema in src/api/database/ is ahead of drizzle/*.sql, so the test database built",
        "from those files no longer matches the real one. Someone pushed without generating.",
        "",
        "Fix: cd packages/web && bun run db:generate   (then re-run the test suite)",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`db:verify — ${before.length} migrations describe the schema. No drift.`);
}
