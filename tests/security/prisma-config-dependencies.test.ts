import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

it("required shared dotenv upgrade parses synthetic quoted multiline values without touching process state", () => {
  const before = process.env.DATABASE_URL;
  const parsed = dotenv.parse(Buffer.from('DATABASE_URL="synthetic-only"\r\nNAME="Synthetic company"\r\nMULTILINE="first\\nsecond"\r\nLITERAL="${DO_NOT_EXPAND}"\r\n'));
  expect(parsed).toEqual({ DATABASE_URL: "synthetic-only", NAME: "Synthetic company",
    MULTILINE: "first\nsecond", LITERAL: "${DO_NOT_EXPAND}" });
  expect(process.env.DATABASE_URL).toBe(before);
});
it("Prisma configuration preserves explicit schema and synthetic datasource without connecting", () => {
  const url = "postgresql://synthetic:synthetic@example.invalid/synthetic";
  const config = defineConfig({ schema: "prisma", datasource: { url } });
  expect(config.schema).toBe("prisma"); expect(config.datasource?.url).toBe(url);
});
