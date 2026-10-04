export function syntheticBillingPolicy(overrides: Record<string, any> = {}): any {
  return { currency: "UZS", precision: 2, rounding: "HALF_EVEN", weight: { source: "recorded_order_kg", rule: "as_recorded" },
    zones: { source: "structured_address_cities", mappings: [{ origin: "Synthetic A", destination: "Synthetic B", zone: 1, originCountry:"ZZ", destinationCountry:"ZZ", coverageType:"domestic", transportMode:"ROAD" }] },
    tariff: { strategy: "FIXED_LANE", priceType: "bucket", includedServices: ["delivery"] }, fees: [{ service: "synthetic_packing", amount: "0.01" }],
    discounts: [], tax: { treatment: "exclusive_percent", rate: "10", authorityReference: "SYNTHETIC TEST TAX ONLY" },
    calculationOrder: "discount_then_tax", roundingStage: "each_component",
    billing: { mode: "manual", eligibleOrderStates: ["pending", "delivered"], dueDays: 7, numberPrefix: "SYNTHETIC" }, ...overrides };
}
