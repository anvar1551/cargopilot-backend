-- Use time-ordered UUID v7 for future primary keys. Existing UUID rows remain valid and unchanged.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
  WITH
    unix_ms AS (
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS value
    ),
    random_hex AS (
      SELECT encode(gen_random_bytes(10), 'hex') AS value
    ),
    variant AS (
      SELECT substr('89ab', (get_byte(gen_random_bytes(1), 0) & 3) + 1, 1) AS value
    )
  SELECT (
    right(lpad(to_hex(unix_ms.value), 12, '0'), 12) ||
    '7' ||
    substr(random_hex.value, 1, 3) ||
    variant.value ||
    substr(random_hex.value, 4, 15)
  )::uuid
  FROM unix_ms, random_hex, variant;
$$;

ALTER TABLE "Organization" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "CompanyPaymentSetting" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Role" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Permission" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "RolePermission" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "CompanyMembership" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "MembershipRole" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "MembershipScope" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "User" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Warehouse" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "DriverWarehouseAccess" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Order" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "PaymentProviderConfig" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "PaymentIntent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "PaymentAttempt" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "PaymentWebhookEvent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "PaymentLedgerEntry" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "IntegrationProvider" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "RouteTemplate" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "RouteTemplateLeg" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "CarrierRoutingRule" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "IntegrationProviderSecret" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "IntegrationOutbox" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "IntegrationDeliveryAttempt" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "IntegrationWebhookEvent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "IntegrationWebhookCanonicalEvent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "IntegrationCanonicalEvent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "OrderLeg" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "PricingComponent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "OrderDocument" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "PricingRegion" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "ZoneMatrixEntry" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "TariffPlan" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "TariffRate" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "DeliverySlaRule" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "OperationalSlaPolicy" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "CashCollection" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "CashCollectionEvent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "OrderLabelJob" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Tracking" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Address" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "CustomerEntity" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "OrderAttachment" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Invoice" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "Parcel" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "UserNotification" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "SupportTicket" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "SupportQueue" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "SupportAssignmentRule" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "SupportTicketMessage" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "SupportTicketNote" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "SupportTicketEvent" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
ALTER TABLE "AnalyticsDomainEventOutbox" ALTER COLUMN "id" SET DEFAULT public.uuid_generate_v7();
