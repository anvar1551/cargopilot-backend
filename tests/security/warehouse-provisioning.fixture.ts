import { WAREHOUSE_PROVISIONING_REVISION } from "../../src/modules/warehouse-core/application/warehouseProvisioning";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalOnboardingPermit, ONBOARDING_OPERATOR } from "../../src/modules/identity-access/application/tenant-onboarding";
import { delegationFingerprint } from "../../src/modules/identity-access/application/operational-profiles";

/** Synthetic keys only: private material remains in memory and is never returned or logged. */
export function syntheticWarehouseOwner() {
  const keys = generateKeyPairSync("ed25519");
  const keyFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const directory = mkdtempSync(join(tmpdir(), "cp-warehouse-owner-")), registryPath = join(directory, "registry.json");
  const prior = process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
  const register = () => {
    writeFileSync(registryPath, JSON.stringify({ version: 1, enabled: true, revoked: false, operatorId: ONBOARDING_OPERATOR,
      profileRevision: WAREHOUSE_PROVISIONING_REVISION, keyFingerprint, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) }));
    process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = registryPath;
  };
  register();
  return {
    register,
    request(membershipId: string, action = "operator-authorize") {
      const intent = { operationId: randomUUID(), membershipId, action, profileRevision: WAREHOUSE_PROVISIONING_REVISION, reason: "Synthetic explicit warehouse provisioning authority" };
      const now = Date.now(), permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint, operationId: intent.operationId,
        intentFingerprint: delegationFingerprint("warehouse-operator-authority", intent), profileRevision: WAREHOUSE_PROVISIONING_REVISION,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() };
      return { intent, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64") };
    },
    cleanup() { unlinkSync(registryPath); rmdirSync(directory); if (prior === undefined) delete process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH; else process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = prior; },
  };
}
