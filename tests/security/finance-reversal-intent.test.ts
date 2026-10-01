import { Prisma } from "@prisma/client";
import { assertReversalRetry } from "../../src/modules/finance-core/infrastructure/journal-integrity";
const decimal = (value: string) => new Prisma.Decimal(value);
const intent = { actorUserId: "maker", postingDate: new Date("2026-01-01"), reason: "Synthetic reversal" };
function fixture() {
  const original: any = { id: "original", documentId: "document", totalDebitBase: decimal("0.1000"), totalCreditBase: decimal("0.1000"), document: { currency: "UZS", totalAmount: decimal("0.1000"), baseAmount: decimal("0.1000"), fxRate: decimal("1.0000000001") }, lines: [{ lineNumber: 1, accountId: "account", currency: "UZS", fxRate: decimal("1.0000000001"), debitAmount: decimal("0.1000"), creditAmount: decimal("0"), debitBase: decimal("0.1000"), creditBase: decimal("0") }] };
  const result: any = { ...original, id: "reversal", reversalOfId: original.id, status: "posted", postingDate: intent.postingDate, description: intent.reason, document: { ...original.document, status: "posted", reversalOfId: original.documentId, createdByUserId: intent.actorUserId, sourceType: "finance_journal_reversal", sourceId: original.id, postingDate: intent.postingDate, description: intent.reason }, lines: original.lines.map((line: any) => ({ ...line, debitAmount: line.creditAmount, creditAmount: line.debitAmount, debitBase: line.creditBase, creditBase: line.debitBase })) };
  return { original, result };
}
test("identical exact financial reversal basis matches", () => { const { original, result } = fixture(); expect(() => assertReversalRetry(result, original, intent)).not.toThrow(); });
test.each(["target", "actor", "date", "reason", "status", "amount", "fx", "line", "source"])("conflicting %s cannot return another operation's receipt", kind => {
  const { original, result } = fixture();
  if (kind === "target") result.reversalOfId = "other";
  if (kind === "actor") result.document.createdByUserId = "other";
  if (kind === "date") result.postingDate = new Date("2026-01-02");
  if (kind === "reason") result.description = "different";
  if (kind === "status") result.status = "draft";
  if (kind === "amount") result.document.totalAmount = decimal("0.1001");
  if (kind === "fx") result.document.fxRate = decimal("1.0000000002");
  if (kind === "line") result.lines[0].creditBase = decimal("0.1001");
  if (kind === "source") result.document.sourceId = "other";
  expect(() => assertReversalRetry(result, original, intent)).toThrow(expect.objectContaining({ code: "FINANCE_REVERSAL_IDEMPOTENCY_CONFLICT", statusCode: 409 }));
});
