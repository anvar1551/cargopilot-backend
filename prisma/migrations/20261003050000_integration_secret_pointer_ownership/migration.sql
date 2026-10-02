-- Additive typed bridge: never cast, infer or backfill historical text pointers.
ALTER TABLE "IntegrationProvider" ADD COLUMN "activeSecretId" UUID;
CREATE UNIQUE INDEX "IntegrationProviderSecret_identity_owner_key"
  ON "IntegrationProviderSecret" ("id", "providerId");
ALTER TABLE "IntegrationProvider"
  ADD CONSTRAINT "IntegrationProvider_active_secret_owner_fkey"
  FOREIGN KEY ("activeSecretId", "id") REFERENCES "IntegrationProviderSecret" ("id", "providerId")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "IntegrationProvider_active_secret_complete_check"
  CHECK (("secretRef" IS NULL AND "activeSecretId" IS NULL)
    OR ("secretRef" IS NOT NULL AND "activeSecretId" IS NOT NULL
      AND lower("secretRef") = "activeSecretId"::text)) NOT VALID;
