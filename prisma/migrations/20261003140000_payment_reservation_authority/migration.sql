-- No historical adoption. Nullable all-empty receipts remain legacy/unaccepted.
ALTER TABLE "PaymentIntent"
 ADD COLUMN "reservationTenantId" uuid,
 ADD COLUMN "reservationInvoiceId" uuid,
 ADD COLUMN "reservationLegalEntityId" uuid,
 ADD COLUMN "reservationAcceptedAt" timestamp(3),
 ADD COLUMN "reservationIssuedAt" timestamp(3),
 ADD COLUMN "reservationRequestHash" varchar(64),
 ADD COLUMN "reservationAuthorityHash" varchar(64);
CREATE UNIQUE INDEX "Invoice_reservation_source_key" ON "Invoice"("tenantId",id,"orderId","companyId",currency);
CREATE INDEX "PaymentReservation_owner_idx" ON "PaymentIntent"("reservationTenantId","companyId","reservationLegalEntityId");
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentReservation_invoice_fkey"
 FOREIGN KEY ("reservationTenantId","reservationInvoiceId","orderId","companyId",currency)
 REFERENCES "Invoice"("tenantId",id,"orderId","companyId",currency) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentReservation_entity_fkey"
 FOREIGN KEY ("reservationLegalEntityId","reservationTenantId","companyId")
 REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentReservation_complete_check" CHECK (
 (num_nonnulls("reservationTenantId","reservationInvoiceId","reservationLegalEntityId","reservationAcceptedAt","reservationIssuedAt","reservationRequestHash","reservationAuthorityHash")=0)
 OR (num_nonnulls("reservationTenantId","reservationInvoiceId","reservationLegalEntityId","reservationAcceptedAt","reservationIssuedAt","reservationRequestHash","reservationAuthorityHash")=7
 AND "amountMinor">0 AND currency IN ('UZS','USD','CNY')
 AND "reservationRequestHash" ~ '^[a-f0-9]{64}$' AND "reservationAuthorityHash" ~ '^[a-f0-9]{64}$')) NOT VALID;
CREATE FUNCTION cp_payment_reservation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD."reservationAcceptedAt" IS NOT NULL THEN RAISE EXCEPTION 'Accepted payment reservation cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF OLD."reservationAcceptedAt" IS NULL AND NEW."reservationAcceptedAt" IS NOT NULL THEN
  RAISE EXCEPTION 'Legacy payment reservation cannot be adopted';
 END IF;
 IF OLD."reservationAcceptedAt" IS NOT NULL AND
  ROW(OLD.id,OLD."companyId",OLD."orderId",OLD.provider,OLD.environment,OLD."providerConfigId",OLD."amountMinor",OLD.currency,OLD."idempotencyKey",OLD."metadataJson",OLD."reservationTenantId",OLD."reservationInvoiceId",OLD."reservationLegalEntityId",OLD."reservationAcceptedAt",OLD."reservationIssuedAt",OLD."reservationRequestHash",OLD."reservationAuthorityHash")
  IS DISTINCT FROM
  ROW(NEW.id,NEW."companyId",NEW."orderId",NEW.provider,NEW.environment,NEW."providerConfigId",NEW."amountMinor",NEW.currency,NEW."idempotencyKey",NEW."metadataJson",NEW."reservationTenantId",NEW."reservationInvoiceId",NEW."reservationLegalEntityId",NEW."reservationAcceptedAt",NEW."reservationIssuedAt",NEW."reservationRequestHash",NEW."reservationAuthorityHash") THEN
  RAISE EXCEPTION 'Accepted payment reservation authority is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PaymentReservation_immutable" BEFORE UPDATE OR DELETE ON "PaymentIntent" FOR EACH ROW EXECUTE FUNCTION cp_payment_reservation_immutable();
CREATE FUNCTION cp_payment_reservation_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Payment reservation truncation is unavailable'; END $$;
CREATE TRIGGER "PaymentReservation_no_truncate" BEFORE TRUNCATE ON "PaymentIntent" FOR EACH STATEMENT EXECUTE FUNCTION cp_payment_reservation_no_truncate();
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentReservation_order_fkey"
 FOREIGN KEY ("reservationTenantId","orderId","companyId") REFERENCES "Order"("tenantId",id,"ownerOrgId")
 ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
