import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalOnboardingPermit, ONBOARDING_OPERATOR } from "../../src/modules/identity-access/application/tenant-onboarding";
import { delegationFingerprint } from "../../src/modules/identity-access/application/operational-profiles";
import { DRIVER_DELEGATION_REVISION } from "../../src/modules/identity-access/application/driver-profiles";

/** Synthetic keys only: private material remains in memory and is never returned or logged. */
export function syntheticDriverOwner() {
  const keys = generateKeyPairSync("ed25519");
  const keyFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const directory = mkdtempSync(join(tmpdir(), "cp-driver-owner-")), registryPath = join(directory, "registry.json");
  const prior = process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
  const register = () => {
    writeFileSync(registryPath, JSON.stringify({ version: 1, enabled: true, revoked: false, operatorId: ONBOARDING_OPERATOR,
      profileRevision: DRIVER_DELEGATION_REVISION, keyFingerprint, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) }));
    process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = registryPath;
  };
  register();
  return {
    register,
    request(membershipId: string, profiles = ["local-driver.v1", "linehaul-driver.v1"], action = "operator-authorize") {
      const intent = { operationId: randomUUID(), membershipId, action, profileRevisions: [...profiles].sort(),
        ceilingRevision: DRIVER_DELEGATION_REVISION, profileRevision: DRIVER_DELEGATION_REVISION, reason: "Synthetic explicit owner-approved driver ceiling" };
      const now = Date.now(), permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint, operationId: intent.operationId,
        intentFingerprint: delegationFingerprint("operator-authority", intent), profileRevision: DRIVER_DELEGATION_REVISION,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() };
      return { intent, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64") };
    },
    cleanup() { unlinkSync(registryPath); rmdirSync(directory); if (prior === undefined) delete process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH; else process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = prior; },
  };
}
