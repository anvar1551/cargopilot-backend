ALTER TABLE "SupportTicket" ADD COLUMN "tenantId" UUID, ADD COLUMN "ownerCompanyMembershipId" UUID;
CREATE INDEX "SupportTicket_tenantId_ownerOrgId_status_lastActivityAt_idx" ON "SupportTicket"("tenantId", "ownerOrgId", "status", "lastActivityAt");
CREATE UNIQUE INDEX "SupportQueue_company_identity_key" ON "SupportQueue"("companyId", "id");
ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SupportTicket_tenant_owner_fkey" FOREIGN KEY ("tenantId", "ownerOrgId") REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "SupportTicket_tenant_assigned_fkey" FOREIGN KEY ("tenantId", "assignedOrgId") REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "SupportTicket_order_owner_fkey" FOREIGN KEY ("tenantId", "orderId", "ownerOrgId") REFERENCES "Order"("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "SupportTicket_customer_owner_fkey" FOREIGN KEY ("tenantId", "customerEntityId") REFERENCES "CustomerEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "SupportTicket_warehouse_owner_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "Warehouse"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "SupportTicket_assignee_context_fkey" FOREIGN KEY ("ownerCompanyMembershipId", "ownerId", "tenantId", "ownerOrgId") REFERENCES "CompanyMembership"("id", "userId", "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Historical queue links may conflict. Enforce new/changed links without certifying old rows.
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_company_queue_fkey" FOREIGN KEY ("ownerOrgId", "queueId") REFERENCES "SupportQueue"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_populated_context_check" CHECK (
  "tenantId" IS NULL OR ("ownerOrgId" IS NOT NULL AND
    (("ownerId" IS NULL AND "ownerCompanyMembershipId" IS NULL) OR
     ("ownerId" IS NOT NULL AND "ownerCompanyMembershipId" IS NOT NULL)))
);
-- No historical mapping/backfill. Nullable old rows remain inaccessible to the new APIs.
