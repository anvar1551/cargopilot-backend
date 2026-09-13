-- Enforce tenant equality for populated ownership relationships during expansion.
-- PostgreSQL MATCH SIMPLE intentionally preserves nullable compatibility: any
-- compound foreign key containing NULL is not checked until later contract work.

CREATE UNIQUE INDEX "Order_tenant_owner_identity_key"
  ON "Order"("tenantId", "id", "ownerOrgId");

ALTER TABLE "CompanyMembership"
  ADD CONSTRAINT "CompanyMembership_tenant_company_fkey"
  FOREIGN KEY ("tenantId", "companyId")
  REFERENCES "Organization"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_tenant_parent_fkey"
  FOREIGN KEY ("tenantId", "parentOrgId")
  REFERENCES "Organization"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Address"
  ADD CONSTRAINT "Address_tenant_customer_fkey"
  FOREIGN KEY ("tenantId", "customerEntityId")
  REFERENCES "CustomerEntity"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CustomerEntity"
  ADD CONSTRAINT "CustomerEntity_tenant_default_address_fkey"
  FOREIGN KEY ("tenantId", "defaultAddressId")
  REFERENCES "Address"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_tenant_owner_org_fkey"
    FOREIGN KEY ("tenantId", "ownerOrgId")
    REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Order_tenant_assigned_org_fkey"
    FOREIGN KEY ("tenantId", "assignedOrgId")
    REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Order_tenant_customer_fkey"
    FOREIGN KEY ("tenantId", "customerEntityId")
    REFERENCES "CustomerEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Order_tenant_sender_address_fkey"
    FOREIGN KEY ("tenantId", "senderAddressId")
    REFERENCES "Address"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Order_tenant_receiver_address_fkey"
    FOREIGN KEY ("tenantId", "receiverAddressId")
    REFERENCES "Address"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Order_tenant_warehouse_fkey"
    FOREIGN KEY ("tenantId", "currentWarehouseId")
    REFERENCES "Warehouse"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Invoice_tenant_order_owner_fkey"
    FOREIGN KEY ("tenantId", "orderId", "companyId")
    REFERENCES "Order"("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "FinanceLegalEntity"
  ADD CONSTRAINT "FinanceLegalEntity_tenant_company_fkey"
  FOREIGN KEY ("tenantId", "companyId")
  REFERENCES "Organization"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
