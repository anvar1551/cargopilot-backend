-- Callback credential selection starts from a stored external provider reference.
-- These indexes do not infer ownership or declare those references globally unique.
CREATE INDEX "PaymentIntent_provider_booking_idx"
  ON "PaymentIntent" ("provider", "providerInvoiceId");
CREATE INDEX "PaymentIntent_provider_payment_idx"
  ON "PaymentIntent" ("provider", "providerPaymentId");
