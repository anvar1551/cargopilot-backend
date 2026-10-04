import { randomUUID } from "node:crypto";
import { SYSTEM_PERMISSIONS } from "../../src/modules/identity-access/permission-registry";
import { OPERATIONAL_PROFILES, delegationFingerprint, profileIntentSchema } from "../../src/modules/identity-access/application/operational-profiles";

it("approved revisions contain only existing operational keys, never delegation or financial authority", () => {
  const catalog = new Set(SYSTEM_PERMISSIONS.map(p => p.key));
  expect(Object.keys(OPERATIONAL_PROFILES)).toHaveLength(3);
  for (const list of Object.values(OPERATIONAL_PROFILES)) {
    expect(Object.isFrozen(list)).toBe(true);
    for (const key of list) {
      expect(catalog.has(key)).toBe(true);
      expect(/^(finance|pricing|billing|membership|role|policy|integration|cash)\./.test(key)).toBe(false);
    }
  }
});
it("normalization sorts and deduplicates explicit warehouse scopes without changing intent", () => {
  const a = randomUUID(), b = randomUUID(), input = { operationId: randomUUID(), profileRevision: "operational-warehouse.v1", warehouseIds: [b, a, b], reason: " approved " };
  const one = profileIntentSchema.parse(input), two = profileIntentSchema.parse({ ...input, warehouseIds: [a, b], reason: "approved" });
  expect(one).toEqual(two);
  expect(delegationFingerprint("grant", one)).toBe(delegationFingerprint("grant", two));
  expect(delegationFingerprint("revoke", one)).not.toBe(delegationFingerprint("grant", one));
});
it.each([
  { profileRevision: "driver.v1", warehouseIds: [] },
  { profileRevision: "finance-checker.v1", warehouseIds: [] },
  { profileRevision: "operational-warehouse.v1", warehouseIds: [] },
  { profileRevision: "operational-clerk.v1", warehouseIds: [randomUUID()] },
  { profileRevision: "operational-warehouse.v1", warehouseIds: Array.from({ length: 21 }, () => randomUUID()) },
  { profileRevision: "operational-clerk.v1", warehouseIds: [], tenantId: randomUUID() },
])("invalid or caller-selected authority rejects: %j", extra => {
  expect(profileIntentSchema.safeParse({ operationId: randomUUID(), reason: "synthetic", ...extra }).success).toBe(false);
});
