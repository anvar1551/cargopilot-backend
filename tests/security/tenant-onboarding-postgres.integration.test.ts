jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, {
  get: (_target, key) => { const value = (mockDb as any)[key]; return typeof value === "function" ? value.bind(mockDb) : value; },
}) }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: async () => null, getRedisPrefix: () => "synthetic",
  withRedisTimeout: (_name: any, work: any) => work() }));
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { generateKeyPairSync, createHash, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { onboardTenant, canonicalOnboardingPermit, ONBOARDING_OPERATOR, ONBOARDING_PROFILE, ONBOARDING_PERMISSIONS } from "../../src/modules/identity-access/application/tenant-onboarding";
import { normalizeTenantOnboardingIntent } from "../../src/modules/identity-access/application/tenant-onboarding-intent";
import { SYSTEM_PERMISSIONS } from "../../src/modules/identity-access/permission-registry";
import { loginUser } from "../../src/modules/identity-access/application/auth.service";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable onboarding identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.password !== "synthetic-worker-only" || target.pathname !== `/cp_worker_${run}`) throw Error("Refusing existing database");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 1000, options: "-c statement_timeout=5000 -c lock_timeout=3000" });
let mockDb: PrismaClient;
const keys = generateKeyPairSync("ed25519"); // In-memory test-only private key.
const keyFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "cp-onboarding-pg-")), registryPath = join(directory, "registry.json");
const registry = { version: 1, enabled: true, revoked: false, operatorId: ONBOARDING_OPERATOR,
  profileRevision: ONBOARDING_PROFILE, keyFingerprint, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) };
const password = randomUUID() + "-test-only";
const credentialHash = bcrypt.hashSync(password, 12);
const credentialCommitment = createHash("sha256").update(credentialHash).digest("hex");
const intent = () => { const suffix = randomUUID().replace(/-/g, "").slice(0, 12); return {
  operationId: randomUUID(), tenant: { code: `SYN-T-${suffix}`, name: "Synthetic tenant" },
  company: { code: `SYN-C-${suffix}`, name: "Synthetic company" },
  administrator: { email: `synthetic-${suffix}@example.invalid`, name: "Synthetic administrator" },
  profileRevision: ONBOARDING_PROFILE, credentialCommitment, reason: "Synthetic owner-approved onboarding" }; };
function request(input = intent()) {
  const normalized = normalizeTenantOnboardingIntent(input), now = Date.now();
  const permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint,
    operationId: normalized.intent.operationId, intentFingerprint: normalized.fingerprint,
    profileRevision: ONBOARDING_PROFILE, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() };
  return { intent: input, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64"), initialCredentialHash: credentialHash };
}
const tables = ["Tenant", "Organization", "User", "TenantMembership", "CompanyMembership", "Role", "RolePermission", "MembershipRole", "MembershipScope", "TenantOnboardingReceipt"];
async function counts() { const result: Record<string, number> = {}; for (const table of tables) result[table] = Number((await pool.query(`SELECT count(*) AS count FROM "${table}"`)).rows[0].count); return result; }
beforeAll(async () => {
  const marker = await pool.query('SELECT "runId" FROM "_CPDisposableRun"');
  if (marker.rows.length !== 1 || marker.rows[0].runId !== run) throw Error("Disposable marker mismatch");
  mockDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4,
    connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
    options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000" }) });
  await mockDb.permission.createMany({ data: SYSTEM_PERMISSIONS.filter(p => (ONBOARDING_PERMISSIONS as readonly string[]).includes(p.key)), skipDuplicates: true });
  process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = registryPath;
  process.env.JWT_SECRET = randomUUID(); process.env.REFRESH_TOKEN_SECRET = randomUUID();
}, 30000);
beforeEach(() => writeFileSync(registryPath, JSON.stringify(registry)));
afterAll(async () => {
  await mockDb?.$disconnect(); await pool.end();
  unlinkSync(registryPath); rmdirSync(directory); // Exact run-owned public-key files only.
  delete process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
});

it("atomic synthetic creation permits real first login with exactly the approved owned context", async () => {
  const args = request(), result = await onboardTenant(mockDb, args);
  const membership = await mockDb.companyMembership.findUniqueOrThrow({ where: { id: result.companyMembershipId }, include: {
    tenantMembership: true, company: true, roles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } }, scopes: true } });
  expect(membership.tenantId).toBe(result.tenantId); expect(membership.tenantMembership?.userId).toBe(result.userId);
  expect(membership.company.tenantId).toBe(result.tenantId);
  expect(membership.roles).toHaveLength(1); const role = membership.roles[0].role;
  expect(role.isSystem).toBe(false); expect(role.isOwnerRole).toBe(false); expect(role.companyId).toBe(result.companyId);
  expect(role.rolePermissions.map(p => p.permission.key).sort()).toEqual([...ONBOARDING_PERMISSIONS].sort());
  expect(membership.scopes.map(s => [s.scopeType, s.scopeRefId])).toEqual([["company", result.companyId]]);
  const accepted = await loginUser({ email: args.intent.administrator.email, password });
  expect(accepted.user.tenantId).toBe(result.tenantId); expect(accepted.user.companyMembershipId).toBe(result.companyMembershipId);
  expect(accepted.user.tenantMembershipId).toBe(result.tenantMembershipId);
  expect(accepted.user.permissionCodes.sort()).toEqual([...ONBOARDING_PERMISSIONS].sort());
  expect(typeof accepted.token).toBe("string"); expect(typeof accepted.refreshToken).toBe("string");
});
it("matching normalized retry/lost acknowledgement returns original IDs without resetting credentials or rows", async () => {
  const args = request(), original = await onboardTenant(mockDb, args), before = await counts();
  const retry = request({ ...args.intent, company: { ...args.intent.company, name: " Synthetic company " } });
  expect(await onboardTenant(mockDb, retry)).toEqual(original); expect(await counts()).toEqual(before);
  expect(await onboardTenant(mockDb, { ...retry, initialCredentialHash: undefined })).toEqual(original);
  await expect(onboardTenant(mockDb, { ...retry, initialCredentialHash: await bcrypt.hash(randomUUID(), 12) })).rejects.toThrow("ONBOARDING_CREDENTIAL_CONFLICT");
  expect(await counts()).toEqual(before);
  const user = await mockDb.user.findUniqueOrThrow({ where: { id: original.userId } });
  expect(await bcrypt.compare(password, user.password)).toBe(true);
});
it("four concurrent identical operations produce one graph and one immutable accepted audit", async () => {
  const args = request(), before = await counts(); const results = await Promise.all(Array.from({ length: 4 }, () => onboardTenant(mockDb, args)));
  expect(results.every(r => r.companyId === results[0].companyId)).toBe(true);
  const after = await counts(); for (const table of tables) expect(after[table] - before[table]).toBe(table === "RolePermission" ? 6 : 1);
});
it("signed conflicting reuse rejects without creating or changing business records", async () => {
  const args = request(); await onboardTenant(mockDb, args); const before = await counts();
  await expect(onboardTenant(mockDb, request({ ...args.intent, company: { ...args.intent.company, name: "Different company" } }))).rejects.toThrow("ONBOARDING_CONFLICT");
  expect(await counts()).toEqual(before);
});
it("competing operations for one normalized email produce one identity with no partial tenant", async () => {
  const a = request(), b = request({ ...intent(), administrator: a.intent.administrator }), before = await counts();
  const results = await Promise.allSettled([onboardTenant(mockDb, a), onboardTenant(mockDb, b)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  const after = await counts(); for (const table of tables) expect(after[table] - before[table]).toBe(table === "RolePermission" ? 6 : 1);
});
it("existing mixed-case email identity cannot be adopted or escalated", async () => {
  const args = request(); await mockDb.user.create({ data: { email: args.intent.administrator.email.toUpperCase(), name: "Existing synthetic identity", password: await bcrypt.hash(password, 10) } });
  const before = await counts(); await expect(onboardTenant(mockDb, args)).rejects.toThrow("ONBOARDING_IDENTITY_EXISTS");
  expect(await counts()).toEqual(before);
});
it.each(["signature", "revoked", "profile", "suspended-result"])("rejects %s before any business mutation", async kind => {
  const args = request();
  if (kind === "suspended-result") { const result = await onboardTenant(mockDb, args); await mockDb.tenant.update({ where: { id: result.tenantId }, data: { status: "suspended" } }); }
  if (kind === "signature") args.signature = Buffer.alloc(64).toString("base64");
  if (kind === "revoked") writeFileSync(registryPath, JSON.stringify({ ...registry, revoked: true }));
  if (kind === "profile") args.intent.profileRevision = "finance-checker";
  const before = await counts(); await expect(onboardTenant(mockDb, args)).rejects.toThrow(/ONBOARDING_/); expect(await counts()).toEqual(before);
});
it("receipt insertion failure rolls back all identities, grants and audit together", async () => {
  await pool.query(`CREATE FUNCTION cp_onboarding_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$; CREATE TRIGGER cp_onboarding_fail BEFORE INSERT ON "TenantOnboardingReceipt" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_fail();`);
  const before = await counts();
  try { await expect(onboardTenant(mockDb, request())).rejects.toThrow("ONBOARDING_TRANSACTION_FAILED"); expect(await counts()).toEqual(before); }
  finally { await pool.query('DROP TRIGGER cp_onboarding_fail ON "TenantOnboardingReceipt"; DROP FUNCTION cp_onboarding_fail();'); }
});
it.each(["UPDATE", "DELETE", "TRUNCATE"])("audit tamper %s rejects, preserves graph and permits matching authorized retry", async operation => {
  const args = request(), original = await onboardTenant(mockDb, args);
  // Complete graph snapshots stay inside the test process, including credentials;
  // compare a digest so a failed assertion cannot print sensitive row values.
  async function snapshot() {
    const graph: Record<string, unknown> = {};
    for (const table of tables) {
      graph[table] = (await pool.query(`SELECT to_jsonb(record) AS row FROM "${table}" AS record ORDER BY to_jsonb(record)::text`)).rows;
    }
    return createHash("sha256").update(JSON.stringify(graph)).digest("hex");
  }
  const before = await snapshot();
  const statement = operation === "UPDATE"
    ? 'UPDATE "TenantOnboardingReceipt" SET "reason"=\'altered\' WHERE "operationId"=$1'
    : operation === "DELETE"
      ? 'DELETE FROM "TenantOnboardingReceipt" WHERE "operationId"=$1'
      : 'TRUNCATE TABLE "TenantOnboardingReceipt"';
  await expect(pool.query(statement, operation === "TRUNCATE" ? [] : [args.intent.operationId]))
    .rejects.toMatchObject({ code: "P0001", message: "Accepted onboarding audit is immutable" });
  expect(await snapshot()).toBe(before);
  expect(await onboardTenant(mockDb, { ...args, initialCredentialHash: undefined })).toEqual(original);
  expect(await snapshot()).toBe(before);
  if (operation === "TRUNCATE") {
    const trigger = await pool.query(`SELECT (tgtype & 32) <> 0 AS truncate_event,
      (tgtype & 2) <> 0 AS before_event, (tgtype & 1) = 0 AS statement_level
      FROM pg_trigger WHERE tgrelid='"TenantOnboardingReceipt"'::regclass
      AND tgname='TenantOnboardingReceipt_no_truncate' AND NOT tgisinternal`);
    expect(trigger.rows).toEqual([{ truncate_event: true, before_event: true, statement_level: true }]);
  }
});
it("database audit is immutable and cross-tenant receipt references cannot be forged", async () => {
  const a = request(); await onboardTenant(mockDb, a);
  await expect(pool.query('UPDATE "TenantOnboardingReceipt" SET "reason"=$1 WHERE "operationId"=$2', ["altered", a.intent.operationId])).rejects.toThrow("immutable");
  await expect(pool.query('DELETE FROM "TenantOnboardingReceipt" WHERE "operationId"=$1', [a.intent.operationId])).rejects.toThrow("immutable");
  // Negative constraint fixtures only, deliberately without receipts. Reusing an
  // already receipted ID would fail uniqueness and mask broken compound FKs.
  async function referenceGraph() {
    const source = intent();
    const tenant = await mockDb.tenant.create({ data: source.tenant });
    const company = await mockDb.organization.create({ data: { ...source.company, type: "company", tenantId: tenant.id } });
    const user = await mockDb.user.create({ data: { ...source.administrator, password: await bcrypt.hash(password, 10) } });
    const tm = await mockDb.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id } });
    const cm = await mockDb.companyMembership.create({ data: { tenantId: tenant.id, companyId: company.id, userId: user.id, tenantMembershipId: tm.id } });
    const role = await mockDb.role.create({ data: { companyId: company.id, name: "Synthetic FK fixture", code: "synthetic-fk-fixture" } });
    return [tenant.id, company.id, user.id, tm.id, cm.id, role.id];
  }
  const owned = await referenceGraph(), foreign = await referenceGraph(), before = await counts();
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const refs = [...owned]; refs[index] = foreign[index];
    await expect(pool.query(`INSERT INTO "TenantOnboardingReceipt" ("operationId","operatorId","keyFingerprint","profileRevision","intentFingerprint","reason","tenantId","companyId","userId","tenantMembershipId","companyMembershipId","roleId") VALUES ($1,$2,$3,$4,$5,'synthetic invalid reference',$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), ONBOARDING_OPERATOR, keyFingerprint, ONBOARDING_PROFILE, "a".repeat(64), ...refs])).rejects.toMatchObject({ code: "23503" });
    expect(await counts()).toEqual(before);
  }
  const constraints = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='"TenantOnboardingReceipt"'::regclass AND contype='f'`);
  expect(constraints.rows.map(row => row.conname).sort()).toEqual([
    "OnboardingReceipt_tenant_fkey", "OnboardingReceipt_company_fkey", "OnboardingReceipt_user_fkey",
    "OnboardingReceipt_tm_fkey", "OnboardingReceipt_bridge_fkey", "OnboardingReceipt_owner_fkey", "OnboardingReceipt_role_fkey",
  ].sort());
});
