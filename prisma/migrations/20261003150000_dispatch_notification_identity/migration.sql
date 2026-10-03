-- Nullable expansion: existing notifications remain unchanged. No ownership inference.
ALTER TABLE "UserNotification" ADD COLUMN "dispatchTrackingId" uuid;
CREATE UNIQUE INDEX "Tracking_order_identity_key" ON "Tracking" (id, "orderId");
CREATE UNIQUE INDEX "UserNotification_dispatch_recipient_key" ON "UserNotification" ("dispatchTrackingId", "companyMembershipId");
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_dispatch_source_fkey"
 FOREIGN KEY ("dispatchTrackingId", "orderId") REFERENCES "Tracking" (id, "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_dispatch_complete_check" CHECK (
 "dispatchTrackingId" IS NULL OR ("orderId" IS NOT NULL AND "tenantId" IS NOT NULL AND "companyId" IS NOT NULL
 AND "companyMembershipId" IS NOT NULL AND type = 'order')) NOT VALID;
-- Retention cleanup remains permitted; only accepted source/recipient/content retargeting is denied.
CREATE FUNCTION cp_dispatch_notification_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."dispatchTrackingId" IS NULL AND NEW."dispatchTrackingId" IS NOT NULL THEN
 RAISE EXCEPTION 'Legacy notifications cannot acquire dispatch acceptance' USING ERRCODE='23514';
 END IF;
 IF OLD."dispatchTrackingId" IS NOT NULL AND ROW(NEW."dispatchTrackingId",NEW."orderId",NEW."tenantId",NEW."companyId",NEW."companyMembershipId",NEW."userId",NEW.type,NEW.title,NEW.body,NEW.data,NEW."createdAt")
 IS DISTINCT FROM ROW(OLD."dispatchTrackingId",OLD."orderId",OLD."tenantId",OLD."companyId",OLD."companyMembershipId",OLD."userId",OLD.type,OLD.title,OLD.body,OLD.data,OLD."createdAt") THEN
 RAISE EXCEPTION 'Accepted dispatch notification is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "UserNotification_dispatch_immutable" BEFORE UPDATE ON "UserNotification" FOR EACH ROW EXECUTE FUNCTION cp_dispatch_notification_immutable();
