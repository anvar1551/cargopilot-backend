-- Existing required source columns establish company/order/provider equality.
-- No inferred tenant backfill or invoice/approval acceptance is introduced.
CREATE UNIQUE INDEX "Order_payment_owner_key" ON "Order" ("id", "ownerOrgId");
CREATE UNIQUE INDEX "PaymentProviderConfig_execution_key" ON "PaymentProviderConfig" ("id", "companyId", "provider", "environment");
CREATE UNIQUE INDEX "PaymentIntent_refund_source_key" ON "PaymentIntent" ("id", "companyId", "orderId", "provider", "environment", "currency");
CREATE UNIQUE INDEX "PaymentIntent_ledger_source_key" ON "PaymentIntent" ("id", "companyId", "orderId", "provider", "currency");

-- NOT VALID protects new/changed references without claiming historical certification.
-- All referencing columns are already NOT NULL, so MATCH SIMPLE has no null bypass.
-- Existing simple foreign keys remain; these stronger ownership paths restrict retargets.
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_order_owner_fkey"
  FOREIGN KEY ("orderId", "companyId") REFERENCES "Order" ("id", "ownerOrgId")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_provider_context_fkey"
  FOREIGN KEY ("providerConfigId", "companyId", "provider", "environment") REFERENCES "PaymentProviderConfig" ("id", "companyId", "provider", "environment")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_intent_context_fkey"
  FOREIGN KEY ("paymentIntentId", "companyId", "orderId", "provider", "environment", "currency") REFERENCES "PaymentIntent" ("id", "companyId", "orderId", "provider", "environment", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_intent_context_fkey"
  FOREIGN KEY ("paymentIntentId", "companyId", "orderId", "provider", "currency") REFERENCES "PaymentIntent" ("id", "companyId", "orderId", "provider", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
