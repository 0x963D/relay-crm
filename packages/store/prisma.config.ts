import { defineConfig } from "prisma/config";

// `prisma generate` needs no database, so the URL is optional here. Migrate commands fail with
// Prisma's own message when it is missing.
const url = process.env.MIGRATION_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(url === undefined ? {} : { datasource: { url } }),
});
