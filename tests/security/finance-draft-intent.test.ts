import Decimal from "decimal.js";
import { buildDraftIntent, assertDraftRetry, projectDraftResult, stableDraftJson } from "../../src/modules/finance-core/domain/draft-intent";
const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const context = { tenantId: uuid, companyId: uuid, tenantMembershipId: uuid, companyMembershipId: uuid, userId: uuid };
const entity = { id: uuid, baseCurrency: "UZS" };
function command(): any { return { companyId: uuid, actorUserId: uuid, idempotencyKey: "synthetic-intent", documentDate: new Date("2026-01-01"), postingDate: new Date("2026-01-01"), currency: "UZS", fxRate: "1.000", metadata: { b: 2, a: 1 }, lines: [{ accountId: uuid, debitAmount: "0.1000", creditAmount: "0" }, { accountId: uuid, debitAmount: "0", creditAmount: "0.1" }] }; }
function stored(intent: ReturnType<typeof buildDraftIntent>): any {
  const s = intent.snapshot;
  return { status: "draft", postingDate: new Date(s.postingDate), description: s.description, totalDebitBase: new Decimal(s.totalDebitBase), totalCreditBase: new Decimal(s.totalCreditBase), document: { ...s.document, ...intent.binding, type: "manual_journal", status: "draft", createdByUserId: context.userId, documentDate: new Date(s.document.documentDate), postingDate: new Date(s.document.postingDate), metadataJson: s.document.metadata }, lines: s.lines.map(l => ({ ...l, metadataJson: l.metadata, account: { id: uuid } })) };
}
it("normalizes exact decimal formatting, UUID case and JSON key order", () => {
  const first = buildDraftIntent(command(), context, entity), retry = command();
  retry.metadata = { a: 1, b: 2 }; retry.fxRate = "1"; retry.lines[0].debitAmount = "0.1"; retry.lines[0].accountId = uuid.toUpperCase();
  const second = buildDraftIntent(retry, context, entity);
  expect(second.fingerprint).toBe(first.fingerprint); expect(() => assertDraftRetry(stored(first), second)).not.toThrow();
});
it("distinguishes exact input amounts even when legacy draft rounding agrees", () => {
  const a = command(), b = command();
  a.lines[0].debitAmount = a.lines[1].creditAmount = "0.10001";
  b.lines[0].debitAmount = b.lines[1].creditAmount = "0.10002";
  const first = buildDraftIntent(a, context, entity), second = buildDraftIntent(b, context, entity);
  expect(first.snapshot).toEqual(second.snapshot); expect(second.fingerprint).not.toBe(first.fingerprint);
  expect(() => assertDraftRetry(stored(first), second)).toThrow("conflicts");
});
it.each(["tenantId", "companyId", "tenantMembershipId", "companyMembershipId", "userId"])("binds %s without permission-cache data", key => {
  const first = buildDraftIntent(command(), context, entity);
  const second = buildDraftIntent(command(), { ...context, [key]: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }, entity);
  expect(second.fingerprint).not.toBe(first.fingerprint);
  expect(buildDraftIntent(command(), { ...context, permissions: ["changed"] } as any, entity).fingerprint).toBe(first.fingerprint);
});
it.each(["metadata", "postingDate", "sourceId", "description"])("rejects changed %s intent", key => {
  const first = buildDraftIntent(command(), context, entity), next = command();
  next[key] = key === "postingDate" ? new Date("2026-01-02") : key === "metadata" ? { a: 3 } : "changed";
  expect(() => assertDraftRetry(stored(first), buildDraftIntent(next, context, entity))).toThrow("conflicts");
});
it("denies legacy binding and mutated normalized stored money", () => {
  const intent = buildDraftIntent(command(), context, entity), legacy = stored(intent), changed = stored(intent);
  legacy.document.draftIntentHash = null; changed.lines[0].debitAmount = "2";
  expect(() => assertDraftRetry(legacy, intent)).toThrow("conflicts"); expect(() => assertDraftRetry(changed, intent)).toThrow("conflicts");
});
it("denies a mutated journal header even if its document is unchanged", () => {
  const intent = buildDraftIntent(command(), context, entity);
  for (const changes of [{ postingDate: new Date("2026-01-02") }, { description: "changed" }])
    expect(() => assertDraftRetry({ ...stored(intent), ...changes }, intent)).toThrow("conflicts");
});
it("explicit projection excludes receipt, creator and raw metadata", () => {
  const result = projectDraftResult(stored(buildDraftIntent(command(), context, entity)));
  expect(result.document).not.toHaveProperty("draftIntentHash"); expect(result.document).not.toHaveProperty("createdByUserId");
  expect(result.document).not.toHaveProperty("metadataJson"); expect(result.lines[0].debitAmount).toBe("0.1");
});
it.each([null, { tenantId: uuid }, { lines: [null] }])("rejects malformed or ownership-bearing inputs", input => {
  expect(() => buildDraftIntent(input === null ? null as any : { ...command(), ...input }, context, entity)).toThrow();
});
it("bounds JSON depth, bytes, unsupported values and decimal representation", () => {
  const cycle: any = {}; cycle.self = cycle;
  for (const value of [cycle, "x".repeat(262145), { fn: () => null }]) expect(() => stableDraftJson(value)).toThrow();
  const c = command(); c.fxRate = "1.00000000001"; expect(() => buildDraftIntent(c, context, entity)).toThrow("precision");
});
