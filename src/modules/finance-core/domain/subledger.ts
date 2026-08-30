import Decimal from "decimal.js";

export type FinanceAgingBucket = "current" | "days1To30" | "days31To60" | "days61To90" | "daysOver90";

export function openItemStatus(originalAmount: string, outstandingAmount: string) {
  const original = new Decimal(originalAmount);
  const outstanding = new Decimal(outstandingAmount);
  if (outstanding.lte(0)) return "settled" as const;
  if (outstanding.gte(original)) return "open" as const;
  return "partial" as const;
}

export function agingBucket(asOf: Date, dueDate: Date): FinanceAgingBucket {
  const asOfDay = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const dueDay = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const overdueDays = Math.floor((asOfDay - dueDay) / 86_400_000);
  if (overdueDays <= 0) return "current";
  if (overdueDays <= 30) return "days1To30";
  if (overdueDays <= 60) return "days31To60";
  if (overdueDays <= 90) return "days61To90";
  return "daysOver90";
}

export function allocationAmount(availableAmount: string, outstandingAmount: string) {
  return Decimal.min(new Decimal(availableAmount), new Decimal(outstandingAmount)).toFixed(4);
}
