-- Expand only. Existing hierarchy ownership is NOT certified or rewritten.
CREATE UNIQUE INDEX "FinanceAccount_entity_identity_key" ON "FinanceAccount" ("legalEntityId", "id");

ALTER TABLE "FinanceAccount" ADD CONSTRAINT "FinanceAccount_owned_parent_fkey"
  FOREIGN KEY ("legalEntityId", "parentId") REFERENCES "FinanceAccount" ("legalEntityId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

-- A null parent remains a root. Validate historical rows only in a separately approved step.
