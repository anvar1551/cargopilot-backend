-- Extend accepted onboarding audit protection without rewriting its published migration.
-- Statement triggers also reject TRUNCATE when there are no receipt rows.
-- Owners/schema administrators can disable or drop triggers; this is not absolute
-- immutability against privileged database administration.
CREATE TRIGGER "TenantOnboardingReceipt_no_truncate"
  BEFORE TRUNCATE ON "TenantOnboardingReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
