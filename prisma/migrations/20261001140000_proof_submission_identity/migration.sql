CREATE TABLE "ProofSubmission" (
  "submissionId" VARCHAR(100) PRIMARY KEY,
  "proofId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tenantMembershipId" UUID NOT NULL,
  "companyMembershipId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "stage" TEXT NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "storageManifest" JSONB NOT NULL,
  "intent" JSONB NOT NULL,
  "photoSha256" CHAR(64) NOT NULL,
  "signatureSha256" CHAR(64) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'accepted',
  "result" JSONB,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  CONSTRAINT "ProofSubmission_id_check" CHECK ("submissionId" ~ '^[A-Za-z0-9-]{1,100}$'),
  CONSTRAINT "ProofSubmission_stage_check" CHECK ("stage" IN ('pickup', 'delivery')),
  CONSTRAINT "ProofSubmission_hash_check" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$' AND "photoSha256" ~ '^[a-f0-9]{64}$' AND "signatureSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ProofSubmission_confirmation_check" CHECK (
    ("state" IN ('accepted', 'stored') AND "result" IS NULL AND "confirmedAt" IS NULL) OR
    ("state" = 'confirmed' AND "result" IS NOT NULL AND "confirmedAt" IS NOT NULL)),
  CONSTRAINT "ProofSubmission_order_owner_fkey" FOREIGN KEY ("tenantId", "orderId", "companyId") REFERENCES "Order"("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProofSubmission_company_context_fkey" FOREIGN KEY ("companyMembershipId", "userId", "tenantId", "companyId") REFERENCES "CompanyMembership"("id", "userId", "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProofSubmission_membership_bridge_fkey" FOREIGN KEY ("companyMembershipId", "tenantMembershipId", "userId", "tenantId") REFERENCES "CompanyMembership"("id", "tenantMembershipId", "userId", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ProofSubmission_proofId_key" ON "ProofSubmission"("proofId");
CREATE INDEX "ProofSubmission_tenantId_companyId_orderId_idx" ON "ProofSubmission"("tenantId", "companyId", "orderId");
CREATE INDEX "ProofSubmission_state_createdAt_idx" ON "ProofSubmission"("state", "createdAt");

-- Identity/content and confirmed receipts cannot be rewritten by application UPDATEs.
CREATE FUNCTION "cp_proof_submission_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."submissionId" IS DISTINCT FROM OLD."submissionId" OR NEW."proofId" IS DISTINCT FROM OLD."proofId" OR
     NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR
     NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."tenantMembershipId" IS DISTINCT FROM OLD."tenantMembershipId" OR
     NEW."companyMembershipId" IS DISTINCT FROM OLD."companyMembershipId" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
     NEW."stage" IS DISTINCT FROM OLD."stage" OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint" OR
     NEW."storageManifest" IS DISTINCT FROM OLD."storageManifest" OR NEW."intent" IS DISTINCT FROM OLD."intent" OR NEW."photoSha256" IS DISTINCT FROM OLD."photoSha256" OR
     NEW."signatureSha256" IS DISTINCT FROM OLD."signatureSha256" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" OR
     OLD."state" = 'confirmed' OR NOT ((OLD."state" = 'accepted' AND NEW."state" = 'stored') OR (OLD."state" = 'stored' AND NEW."state" = 'confirmed')) THEN
    RAISE EXCEPTION 'Immutable proof submission or invalid transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProofSubmission_immutable" BEFORE UPDATE ON "ProofSubmission" FOR EACH ROW EXECUTE FUNCTION "cp_proof_submission_immutable"();
