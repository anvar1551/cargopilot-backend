import { Prisma } from "@prisma/client";

/** Quote every cell; only genuinely typed numeric values bypass text neutralization. */
export function csvEscape(value: unknown): string {
  const numeric = (typeof value === "number" && Number.isFinite(value)) || typeof value === "bigint" ||
    (value instanceof Prisma.Decimal && value.isFinite());
  const raw = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  // Spreadsheet parsers can discard whitespace/controls before recognizing formulas.
  const prefixStripped = raw.replace(/^[\s\p{Cc}\p{Cf}]*/u, "");
  const dangerous = /^[=+\-@]/.test(prefixStripped) || /^[\s\p{Cc}\p{Cf}]*[\t\r\n]/u.test(raw);
  const safe = !numeric && dangerous ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
