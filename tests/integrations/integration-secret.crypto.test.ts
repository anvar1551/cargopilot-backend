import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
} from "../../src/modules/integrations-core/application/integration-secret.crypto";

describe("integration secret crypto", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("round-trips encrypted provider secrets", () => {
    process.env.INTEGRATION_CONFIG_MASTER_KEY = "unit-master-key";

    const encrypted = encryptIntegrationSecret(
      JSON.stringify({ apiKey: "secret-key", webhookSecret: "hook-secret" }),
    );

    expect(encrypted).not.toContain("secret-key");
    expect(decryptIntegrationSecret(encrypted)).toBe(
      JSON.stringify({ apiKey: "secret-key", webhookSecret: "hook-secret" }),
    );
  });

  it("rejects decryption with the wrong master key", () => {
    process.env.INTEGRATION_CONFIG_MASTER_KEY = "unit-master-key";
    const encrypted = encryptIntegrationSecret("sensitive");

    process.env.INTEGRATION_CONFIG_MASTER_KEY = "wrong-master-key";

    expect(() => decryptIntegrationSecret(encrypted)).toThrow();
  });
});
