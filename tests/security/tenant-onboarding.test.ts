import { generateKeyPairSync, createHash, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeTenantOnboardingIntent } from "../../src/modules/identity-access/application/tenant-onboarding-intent";
import { canonicalOnboardingPermit, onboardTenant, prepareOnboardingCredential, ONBOARDING_OPERATOR, ONBOARDING_PROFILE, ONBOARDING_PERMISSIONS } from "../../src/modules/identity-access/application/tenant-onboarding";

const keys = generateKeyPairSync("ed25519"); // Test-only; private key never written/logged.
const keyFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "cp-onboarding-unit-"));
const registryPath = join(directory, "registry.json");
const previousPath = process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
const registry = { version: 1, enabled: true, revoked: false, operatorId: ONBOARDING_OPERATOR,
  profileRevision: ONBOARDING_PROFILE, keyFingerprint,
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) };
const input = () => ({ operationId: randomUUID(), tenant: { code: "synthetic-a", name: "Synthetic tenant" },
  company: { code: "synthetic-company", name: "Synthetic company" }, administrator: { email: "synthetic@example.invalid", name: "Synthetic admin" },
  profileRevision: ONBOARDING_PROFILE, credentialCommitment: "a".repeat(64), reason: "Synthetic controlled onboarding" });
function signed(intent: ReturnType<typeof input>) {
  const normalized = normalizeTenantOnboardingIntent(intent);
  const permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint,
    operationId: normalized.intent.operationId, intentFingerprint: normalized.fingerprint, profileRevision: ONBOARDING_PROFILE,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() };
  return { intent, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64") };
}
beforeEach(() => { writeFileSync(registryPath, JSON.stringify(registry)); process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = registryPath; });
afterAll(() => {
  if (previousPath === undefined) delete process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH; else process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = previousPath;
  unlinkSync(registryPath); rmdirSync(directory); // Only exact files/directory created above.
});

it("normalizes deterministic non-secret intent without trusting object key order", () => {
  const a = input(), b = { ...a, tenant: { name: " Synthetic tenant ", code: "SYNTHETIC-A" }, administrator: { name: "Synthetic admin", email: "SYNTHETIC@EXAMPLE.INVALID" } };
  expect(normalizeTenantOnboardingIntent(a)).toEqual(normalizeTenantOnboardingIntent(b));
  expect(normalizeTenantOnboardingIntent({ ...a, company: { ...a.company, name: "Different" } }).fingerprint)
    .not.toBe(normalizeTenantOnboardingIntent(a).fingerprint);
});
it.each(["permissions", "role", "tenantId", "password", "status"])("rejects caller %s fields", field => {
  expect(() => normalizeTenantOnboardingIntent({ ...input(), [field]: "forbidden" })).toThrow();
});
it("rejects nested ownership and reserved CP_ROOT without remapping", () => {
  const a = input();
  expect(() => normalizeTenantOnboardingIntent({ ...a, company: { ...a.company, tenantId: randomUUID() } })).toThrow();
  expect(() => normalizeTenantOnboardingIntent({ ...a, tenant: { ...a.tenant, code: "cp_root" } })).toThrow();
});
it.each(["unconfigured", "revoked", "signature", "intent", "expired", "longExpiry", "operator", "profile"])(
  "rejects %s authority before any database call", async kind => {
    const args: any = signed(input());
    if (kind === "unconfigured") delete process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
    if (kind === "revoked") writeFileSync(registryPath, JSON.stringify({ ...registry, revoked: true }));
    if (kind === "signature") args.signature = Buffer.alloc(64).toString("base64");
    if (kind === "intent") args.intent.company.name = "Tampered";
    if (kind === "expired") args.permit.expiresAt = new Date(Date.now() - 1000).toISOString();
    if (kind === "longExpiry") args.permit.expiresAt = new Date(Date.now() + 600000).toISOString();
    if (kind === "operator") args.permit.operatorId = "tenant-admin";
    if (kind === "profile") args.intent.profileRevision = "all-permissions";
    const transaction = jest.fn();
    await expect(onboardTenant({ $transaction: transaction } as any, args)).rejects.toThrow(/ONBOARDING_/);
    expect(transaction).not.toHaveBeenCalled();
  },
);
it("exposes only the exact owner-approved immutable six-key profile", () => {
  expect(Object.isFrozen(ONBOARDING_PERMISSIONS)).toBe(true);
  expect([...ONBOARDING_PERMISSIONS]).toEqual(["organizations.read", "customers.read", "customers.write", "shipment.view", "shipment.create", "notifications.read"]);
});
it("binds a prepared credential to the signed intent and rejects substitution before database work", async () => {
  const credential = await prepareOnboardingCredential(randomUUID());
  expect(credential.credentialCommitment).toBe(createHash("sha256").update(credential.initialCredentialHash).digest("hex"));
  const args = { ...signed(input()), initialCredentialHash: credential.initialCredentialHash };
  const transaction = jest.fn();
  await expect(onboardTenant({ $transaction: transaction } as any, args)).rejects.toThrow("ONBOARDING_CREDENTIAL_CONFLICT");
  expect(transaction).not.toHaveBeenCalled();
  for (const password of [" ".repeat(12), "short", "x".repeat(73), "bounded-test\ncontrol"])
    await expect(prepareOnboardingCredential(password)).rejects.toThrow("ONBOARDING_CREDENTIAL_INVALID");
});
it("legacy entrypoint rejects with a clean environment and import-safe source wrappers", () => {
  const scripts = require("../../package.json").scripts;
  const command = scripts["bootstrap:erp-access"] as string;
  expect(command.startsWith('node -e "')).toBe(true);
  const child = spawnSync(process.execPath, ["-e", command.slice(9, -1)], {
    env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8", timeout: 5000,
  });
  expect(child.status).toBe(1); expect(child.stdout).toBe("");
  expect(child.stderr).toContain("Legacy bootstrap disabled");
  const before = process.exitCode;
  require("../../src/scripts/bootstrap-erp-access"); require("../../src/scripts/bootstrap-support");
  expect(process.exitCode).toBe(before);
  for (const name of ["bootstrap:erp-access", "start:bootstrap:erp-access", "bootstrap:support", "start:bootstrap:support"])
    expect(scripts[name]).toBe(command);
});
it("declares the same supported Node range in root package/lock metadata", () => {
  const pkg = require("../../package.json"), lock = require("../../package-lock.json");
  expect(pkg.engines.node).toBe(">=22.12.0 <23"); expect(lock.packages[""].engines).toEqual(pkg.engines);
  const satisfies = require("semver").satisfies;
  expect(satisfies("22.11.0", pkg.engines.node)).toBe(false);
  expect(satisfies("22.12.0", pkg.engines.node)).toBe(true);
  expect(satisfies("23.0.0", pkg.engines.node)).toBe(false);
});
