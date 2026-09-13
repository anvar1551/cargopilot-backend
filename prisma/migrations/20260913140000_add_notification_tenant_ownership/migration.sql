-- Additive notification ownership expansion. Existing rows remain unowned and
-- are intentionally excluded by tenant-facing application queries.
ALTER TABLE "UserNotification"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "companyId" UUID,
  ADD COLUMN "companyMembershipId" UUID,
  ADD CONSTRAINT "UserNotification_ownership_presence_check" CHECK (
    ("tenantId" IS NULL AND "companyId" IS NULL AND "companyMembershipId" IS NULL)
    OR
    ("tenantId" IS NOT NULL AND "companyId" IS NOT NULL AND "companyMembershipId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "CompanyMembership_notification_owner_key"
  ON "CompanyMembership"("id", "userId", "tenantId", "companyId");

CREATE INDEX "UserNotification_tenant_company_membership_user_createdAt_idx"
  ON "UserNotification"("tenantId", "companyId", "companyMembershipId", "userId", "createdAt");

CREATE INDEX "UserNotification_tenant_company_membership_user_readAt_idx"
  ON "UserNotification"("tenantId", "companyId", "companyMembershipId", "userId", "readAt");

ALTER TABLE "UserNotification"
  ADD CONSTRAINT "UserNotification_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "UserNotification_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "Organization"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "UserNotification_recipient_membership_fkey"
    FOREIGN KEY ("companyMembershipId", "userId", "tenantId", "companyId")
    REFERENCES "CompanyMembership"("id", "userId", "tenantId", "companyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "UserNotification_tenant_order_fkey"
    FOREIGN KEY ("tenantId", "orderId", "companyId")
    REFERENCES "Order"("tenantId", "id", "ownerOrgId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
