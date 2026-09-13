-- Add the customer identity to the default-address relationship. The existing
-- tenant-only foreign key remains as compatibility defense in depth.
CREATE UNIQUE INDEX "Address_tenant_customer_identity_key"
  ON "Address"("tenantId", "id", "customerEntityId");

-- NOT VALID avoids asserting that transitional rows already satisfy the new
-- relationship. PostgreSQL still enforces it for new and updated rows. A later
-- audited backfill/cutover must validate it before tenant ownership is complete.
ALTER TABLE "CustomerEntity"
  ADD CONSTRAINT "CustomerEntity_tenant_owned_default_address_fkey"
  FOREIGN KEY ("tenantId", "defaultAddressId", "id")
  REFERENCES "Address"("tenantId", "id", "customerEntityId")
  ON DELETE RESTRICT ON UPDATE RESTRICT
  NOT VALID;
