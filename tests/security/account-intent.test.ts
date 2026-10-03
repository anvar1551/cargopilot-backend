import { normalizeAccountIntent, accountIntentHash } from "../../src/modules/finance-core/domain/account-intent";
const command = { operationId: "aabbccdd-0000-4000-8000-000000000001", companyId: "company-a", actorUserId: "actor-a", code: "SYNTHETIC", name: "Synthetic", type: "asset" as const, allowPosting: false, isControlAccount: false };
const context = { tenantId: "tenant-a", companyId: "company-a", companyMembershipId: "membership-a", tenantMembershipId: "tenant-membership-a", userId: "actor-a" };
const hash = (input: any, who = context) => accountIntentHash(normalizeAccountIntent(input), who, "entity-a");
it("normalizes whitespace/defaults/UUIDs and sorted bounded JSON content", () => {
  expect(hash({ ...command, operationId: command.operationId.toUpperCase(), name: " Synthetic ", metadata: { z: 1, a: 2 } })).toBe(hash({ ...command, metadata: { a: 2, z: 1 } }));
  expect(hash(command)).toBe(hash({ ...command, currency: null, parentId: null, description: null }));
});
it.each(["name", "code", "allowPosting", "description", "metadata"])("%s changes accepted content fingerprint", field => { expect(hash({ ...command, [field]: field === "allowPosting" ? true : field === "metadata" ? { different: true } : "different" })).not.toBe(hash(command)); });
it.each(["tenantId", "companyId", "companyMembershipId", "tenantMembershipId", "userId"])("%s binds identity in fingerprint", field => { expect(hash(command, { ...context, [field]: "other" })).not.toBe(hash(command)); });
it.each([{ ...command, operationId: undefined }, { ...command, operationId: "invalid" }, { ...command, ownerId: "forged" }, { ...command, type: "unknown" }])("rejects missing/malformed identity or unknown authority", input => { expect(() => hash(input)).toThrow(); });
it("non-JSON or excessive metadata cannot be accepted", () => { expect(() => hash({ ...command, metadata: { date: new Date() } })).toThrow(); expect(() => hash({ ...command, metadata: { oversized: "x".repeat(262145) } })).toThrow(); });
