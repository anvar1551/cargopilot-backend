// prisma.config.ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  // used by `prisma migrate` / `prisma migrate dev`
  // Keep `datasource.url` as a compatibility fallback because `prisma migrate dev`
  // currently requires it to locate the database when running migrations.
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrate: {
    url: process.env.DATABASE_URL,
  },
});
