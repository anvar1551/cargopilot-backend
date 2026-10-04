import { calculateAcceptedPrice, parseBillingPolicy, billingRouteIdentity } from "../../src/modules/pricing-core/domain/billing-calculation";
import { syntheticBillingPolicy } from "./billing-policy.fixture";

it("zone zero is explicit and negative, fractional or unsupported zones reject", () => {
  const mapping = syntheticBillingPolicy().zones.mappings[0];
  expect(parseBillingPolicy(syntheticBillingPolicy({zones:{source:"structured_address_cities",mappings:[{...mapping,zone:0}]}})).zones.mappings[0].zone).toBe(0);
  for (const zone of [-1, 0.5, 1001]) expect(() => parseBillingPolicy(syntheticBillingPolicy({zones:{source:"structured_address_cities",mappings:[{...mapping,zone}]}}))).toThrow();
});
it("country-qualified route identity permits same cities across countries and rejects conflicting complete routes", () => {
  const mapping=syntheticBillingPolicy().zones.mappings[0];
  const mappings=[mapping,{...mapping,originCountry:"AA",destinationCountry:"BB",zone:0}];
  expect(parseBillingPolicy(syntheticBillingPolicy({zones:{source:"structured_address_cities",mappings}})).zones.mappings).toHaveLength(2);
  expect(billingRouteIdentity(" Synthetic A ","SYNTHETIC B"," zz ","ZZ")).toBe(billingRouteIdentity(mapping.origin,mapping.destination,mapping.originCountry,mapping.destinationCountry));
  for(const extra of [{...mapping,origin:" SYNTHETIC A ",zone:0},{...mapping,transportMode:"AIR"}])
    expect(()=>parseBillingPolicy(syntheticBillingPolicy({zones:{source:"structured_address_cities",mappings:[mapping,extra]}}))).toThrow();
});

it("preserves exact large money, separate service fees and explicit synthetic tax", () => {
  expect(calculateAcceptedPrice(syntheticBillingPolicy(), "1234567890.12")).toMatchObject({ total: "1358024679.14", currency: "UZS",
    components: [{ type: "base_tariff", amount: "1234567890.12" }, { type: "additional_fee", amount: "0.01" }, { type: "tax", amount: "123456789.01" }] });
});
it("supports explicitly configured arbitrary currency and rounding without metadata defaults", () => {
  for (const currency of ["EUR", "JPY", "KWD", "XTS"]) expect(parseBillingPolicy(syntheticBillingPolicy({ currency })).currency).toBe(currency);
  expect(calculateAcceptedPrice(syntheticBillingPolicy({ precision: 3, rounding: "UP", fees: [], tax: { treatment: "not_applicable", authorityReference: "synthetic" } }), "1.0001").total).toBe("1.001");
});
it.each(["tax", "precision", "rounding", "calculationOrder", "currency", "zones"])("missing %s is not a default", field => {
  const p = syntheticBillingPolicy(); delete p[field]; expect(() => parseBillingPolicy(p)).toThrow();
});
it("duplicate included services and duplicate discounts reject", () => {
  expect(() => parseBillingPolicy(syntheticBillingPolicy({ fees: [{ service: "delivery", amount: "1" }] }))).toThrow();
  expect(() => parseBillingPolicy(syntheticBillingPolicy({ discounts: [{ code: "same", type: "flat", value: "1" }, { code: "same", type: "flat", value: "2" }] }))).toThrow();
});
it("discounts require independent acceptance and obey the explicit configured sequence", () => {
  const p = syntheticBillingPolicy({ fees: [], discounts: [{ code: "test", type: "flat", value: "10" }] });
  expect(calculateAcceptedPrice(p,"100")).toMatchObject({ total: "99.00", requiresIndependentApproval: true });
  expect(calculateAcceptedPrice({ ...p, calculationOrder: "tax_then_discount" }, "100").total).toBe("100.00");
});
it("unsupported automatic modes, tax absence, money Numbers and malformed amounts reject", () => {
  for (const base of ["-1", "1e2", "NaN", 100]) expect(() => calculateAcceptedPrice(syntheticBillingPolicy(), base as any)).toThrow();
  expect(() => parseBillingPolicy(syntheticBillingPolicy({ billing: { mode: "delivery" } }))).toThrow();
  expect(() => parseBillingPolicy(syntheticBillingPolicy({ tax: {} }))).toThrow();
  expect(() => parseBillingPolicy(syntheticBillingPolicy({ fees: [{ service: "packing", amount: 1.2 }] }))).toThrow();
  expect(() => parseBillingPolicy(syntheticBillingPolicy({ discounts: [{ code: "test", type: "percent", value: "101" }] }))).toThrow();
});
