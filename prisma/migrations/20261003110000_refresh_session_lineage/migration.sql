-- Additive tracked segments only; never infer historical successor ownership.
ALTER TABLE "UserRefreshSession"
  ADD COLUMN "rotationDepth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "replacementDepth" INTEGER;
CREATE UNIQUE INDEX "UserRefreshSession_lineage_identity_key" ON "UserRefreshSession"
  ("id", "userId", "tenantId", "tenantMembershipId", "companyMembershipId", "rotationDepth");
-- This deliberately fails rather than silently repairing pre-existing merged chains.
CREATE UNIQUE INDEX "UserRefreshSession_successor_key" ON "UserRefreshSession" ("replacedBySessionId");
ALTER TABLE "UserRefreshSession"
  DROP CONSTRAINT "UserRefreshSession_replacedBySessionId_fkey",
  ADD CONSTRAINT "UserRefreshSession_lineage_fkey" FOREIGN KEY
    ("replacedBySessionId", "userId", "tenantId", "tenantMembershipId", "companyMembershipId", "replacementDepth")
    REFERENCES "UserRefreshSession" ("id", "userId", "tenantId", "tenantMembershipId", "companyMembershipId", "rotationDepth")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "UserRefreshSession_lineage_presence_check" CHECK (
    "rotationDepth" BETWEEN 0 AND 256
    AND (("replacedBySessionId" IS NULL AND "replacementDepth" IS NULL)
      OR ("replacedBySessionId" IS NOT NULL AND "replacementDepth" IS NOT NULL AND "replacementDepth" = "rotationDepth" + 1
        AND "replacementDepth" <= 256 AND "replacedBySessionId" <> "id"
        AND "revokedAt" IS NOT NULL AND "tenantId" IS NOT NULL
        AND "tenantMembershipId" IS NOT NULL AND "companyMembershipId" IS NOT NULL))
    AND ("rotationDepth" = 0 OR ("tenantId" IS NOT NULL AND "tenantMembershipId" IS NOT NULL AND "companyMembershipId" IS NOT NULL))
  ) NOT VALID;
CREATE FUNCTION cp_refresh_lineage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."replacedBySessionId" IS NOT NULL THEN
      RAISE EXCEPTION 'Published refresh lineage must be retained';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."id", NEW."userId", NEW."tenantId", NEW."tenantMembershipId", NEW."companyMembershipId", NEW."tokenHash", NEW."rotationDepth", NEW."createdAt")
      IS DISTINCT FROM
     (OLD."id", OLD."userId", OLD."tenantId", OLD."tenantMembershipId", OLD."companyMembershipId", OLD."tokenHash", OLD."rotationDepth", OLD."createdAt") THEN
    RAISE EXCEPTION 'Refresh session identity is immutable';
  END IF;
  IF OLD."replacedBySessionId" IS NOT NULL AND
      (NEW."replacedBySessionId", NEW."replacementDepth") IS DISTINCT FROM (OLD."replacedBySessionId", OLD."replacementDepth") THEN
    RAISE EXCEPTION 'Published refresh lineage is immutable';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS NULL THEN
    RAISE EXCEPTION 'Revoked refresh sessions cannot be reactivated';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "UserRefreshSession_lineage_guard" BEFORE UPDATE OR DELETE ON "UserRefreshSession"
  FOR EACH ROW EXECUTE FUNCTION cp_refresh_lineage_guard();
-- Confirm a generated successor is accepted by exactly one same-context predecessor at commit.
CREATE FUNCTION cp_refresh_successor_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."rotationDepth" > 0 AND NOT EXISTS (
    SELECT 1 FROM "UserRefreshSession" p WHERE p."replacedBySessionId" = NEW."id"
      AND p."userId" = NEW."userId" AND p."tenantId" = NEW."tenantId"
      AND p."tenantMembershipId" = NEW."tenantMembershipId"
      AND p."companyMembershipId" = NEW."companyMembershipId"
      AND p."replacementDepth" = NEW."rotationDepth" AND p."revokedAt" IS NOT NULL
  ) THEN RAISE EXCEPTION 'Refresh successor requires atomic predecessor acceptance'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "UserRefreshSession_successor_acceptance" AFTER INSERT ON "UserRefreshSession"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cp_refresh_successor_acceptance();
CREATE FUNCTION cp_refresh_lineage_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Refresh lineage cannot be truncated'; END $$;
CREATE TRIGGER "UserRefreshSession_lineage_no_truncate" BEFORE TRUNCATE ON "UserRefreshSession"
  FOR EACH STATEMENT EXECUTE FUNCTION cp_refresh_lineage_no_truncate();
