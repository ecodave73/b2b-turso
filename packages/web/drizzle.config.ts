import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "turso",
  // Two files, one-way import: auth-schema.ts imports `users` from schema.ts, never the
  // reverse. Listing both keeps Better Auth's tables in the generated migrations.
  schema: ["./src/api/database/schema.ts", "./src/api/database/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
