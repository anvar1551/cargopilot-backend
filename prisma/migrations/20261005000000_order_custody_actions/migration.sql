CREATE TABLE "OrderCustodyAction" (
  id uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL, "orderId" uuid NOT NULL,
  "operationId" uuid NOT NULL, sequence integer NOT NULL CHECK(sequence > 0), action text NOT NULL, phase text NOT NULL,
  "actorUserId" uuid NOT NULL, "companyMembershipId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
  "intentHash" char(64) NOT NULL, intent jsonb NOT NULL, "previousEventId" uuid, "warehouseId" uuid, "destinationWarehouseId" uuid,
  "driverUserId" uuid, "driverMembershipId" uuid, "legId" uuid, "trackingId" uuid NOT NULL,
  "beforeState" jsonb NOT NULL, result jsonb NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("driverUserId" IS NULL) = ("driverMembershipId" IS NULL)),
  CHECK (action IN ('pickup-offer','intake','dispatch','transport-accept','receive','last-mile-offer','last-mile-accept','deliver')),
  CHECK (phase IN ('pickup-offered','warehouse','transport-offered','transport','last-mile-offered','last-mile','delivered')),
  CHECK ((action,phase) IN (('pickup-offer','pickup-offered'),('intake','warehouse'),('receive','warehouse'),('dispatch','transport-offered'),
    ('transport-accept','transport'),('last-mile-offer','last-mile-offered'),('last-mile-accept','last-mile'),('deliver','delivered'))),
  CHECK ((phase='warehouse') = ("driverUserId" IS NULL)),
  CHECK ((phase='pickup-offered') = ("warehouseId" IS NULL)),
  CHECK ((phase IN ('pickup-offered','transport-offered','transport')) = ("destinationWarehouseId" IS NOT NULL)),
  FOREIGN KEY ("tenantId","orderId","companyId") REFERENCES "Order"("tenantId",id,"ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("driverMembershipId","driverUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("tenantId","warehouseId") REFERENCES "Warehouse"("tenantId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("tenantId","destinationWarehouseId") REFERENCES "Warehouse"("tenantId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("legId","orderId") REFERENCES "OrderLeg"(id,"orderId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("trackingId","orderId") REFERENCES "Tracking"(id,"orderId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE ("tenantId","operationId"), UNIQUE ("orderId",sequence), UNIQUE(id,"orderId"),
  FOREIGN KEY ("previousEventId","orderId") REFERENCES "OrderCustodyAction"(id,"orderId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "OrderCustodyAction_tenantId_companyId_orderId_sequence_idx" ON "OrderCustodyAction"("tenantId","companyId","orderId",sequence);
CREATE FUNCTION cp_custody_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Custody history is append only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER cp_custody_append_only BEFORE UPDATE OR DELETE ON "OrderCustodyAction" FOR EACH ROW EXECUTE FUNCTION cp_custody_append_only();
CREATE TRIGGER cp_custody_no_truncate BEFORE TRUNCATE ON "OrderCustodyAction" FOR EACH STATEMENT EXECUTE FUNCTION cp_custody_append_only();
CREATE UNIQUE INDEX "Parcel_custody_order_key" ON "Parcel"(id,"orderId");
CREATE TABLE "OrderCustodyParcel" (
  "actionId" uuid NOT NULL, "parcelId" uuid NOT NULL, "orderId" uuid NOT NULL,
  PRIMARY KEY("actionId","parcelId"),
  FOREIGN KEY("actionId","orderId") REFERENCES "OrderCustodyAction"(id,"orderId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY("parcelId","orderId") REFERENCES "Parcel"(id,"orderId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TRIGGER cp_custody_parcel_append_only BEFORE UPDATE OR DELETE ON "OrderCustodyParcel" FOR EACH ROW EXECUTE FUNCTION cp_custody_append_only();
CREATE TRIGGER cp_custody_parcel_no_truncate BEFORE TRUNCATE ON "OrderCustodyParcel" FOR EACH STATEMENT EXECUTE FUNCTION cp_custody_append_only();
