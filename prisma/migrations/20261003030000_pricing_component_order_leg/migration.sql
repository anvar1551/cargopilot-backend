-- Reuse the existing OrderLeg_id_order_key. No historical ownership inference.
-- Existing simple FK remains intentionally; null orderLegId denotes an order-level component.
ALTER TABLE "PricingComponent"
  ADD CONSTRAINT "PricingComponent_order_leg_fkey"
  FOREIGN KEY ("orderLegId", "orderId") REFERENCES "OrderLeg" ("id", "orderId")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
