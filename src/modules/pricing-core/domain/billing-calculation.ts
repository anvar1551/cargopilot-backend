import Decimal from "decimal.js";
import { z } from "zod";
import { OrderStatus, TariffTransportMode } from "@prisma/client";
import { stableDraftJson } from "../../finance-core/domain/draft-intent";

const exact = z.string().max(40).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const key = z.string().min(1).max(60).regex(/^[a-zA-Z0-9_.-]+$/);
export const billingPolicySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  precision: z.number().int().min(0).max(4),
  rounding: z.enum(["HALF_UP", "HALF_EVEN", "DOWN", "UP"]),
  weight: z.object({ source: z.literal("recorded_order_kg"), rule: z.literal("as_recorded") }).strict(),
  zones: z.object({ source: z.literal("structured_address_cities"), mappings: z.array(z.object({
    origin: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(100), zone: z.number().int().min(0).max(1000),
    originCountry: z.string().regex(/^[A-Z]{2}$/), destinationCountry: z.string().regex(/^[A-Z]{2}$/),
    coverageType: z.enum(["domestic", "international"]), transportMode: z.nativeEnum(TariffTransportMode),
  }).strict()).min(1).max(100) }).strict(),
  tariff: z.object({ strategy: z.literal("FIXED_LANE"), priceType: z.literal("bucket"), includedServices: z.array(key).min(1).max(30) }).strict(),
  fees: z.array(z.object({ service: key, amount: exact }).strict()).max(30),
  discounts: z.array(z.object({ code: key, type: z.enum(["flat", "percent"]), value: exact }).strict()).max(10),
  tax: z.discriminatedUnion("treatment", [
    z.object({ treatment: z.literal("exclusive_percent"), rate: exact, authorityReference: z.string().min(1).max(200) }).strict(),
    z.object({ treatment: z.enum(["exempt", "not_applicable"]), authorityReference: z.string().min(1).max(200) }).strict(),
  ]),
  calculationOrder: z.enum(["discount_then_tax", "tax_then_discount"]),
  roundingStage: z.literal("each_component"),
  billing: z.object({ mode: z.literal("manual"), eligibleOrderStates: z.array(z.nativeEnum(OrderStatus)).min(1).max(15),
    dueDays: z.number().int().min(0).max(365), numberPrefix: z.string().min(1).max(20).regex(/^[A-Z0-9-]+$/) }).strict(),
}).strict();
export type BillingPolicy = z.infer<typeof billingPolicySchema>;
const arithmetic = Decimal.clone({ precision: 60, toExpNeg: -60, toExpPos: 60 });
const rounding = { HALF_UP: Decimal.ROUND_HALF_UP, HALF_EVEN: Decimal.ROUND_HALF_EVEN, DOWN: Decimal.ROUND_DOWN, UP: Decimal.ROUND_UP };
export function billingRouteIdentity(origin: string, destination: string, originCountry: string | null, destinationCountry: string | null) {
  return JSON.stringify([origin.trim().toLowerCase(), destination.trim().toLowerCase(),
    originCountry?.trim().toUpperCase() ?? "", destinationCountry?.trim().toUpperCase() ?? ""]);
}
export function parseBillingPolicy(input: unknown): BillingPolicy {
  const p = billingPolicySchema.parse(input);
  const services = [...p.tariff.includedServices, ...p.fees.map(f => f.service)];
  if (new Set(services).size !== services.length || new Set(p.discounts.map(d => d.code)).size !== p.discounts.length)
    throw Object.assign(new Error("Duplicate or already included service/discount"), { statusCode: 400, code: "BILLING_DUPLICATE_COMPONENT" });
  const lanes = p.zones.mappings.map(m => billingRouteIdentity(m.origin, m.destination, m.originCountry, m.destinationCountry));
  if (new Set(lanes).size !== lanes.length) throw Object.assign(new Error("Ambiguous zone mapping"), { statusCode: 400 });
  if (p.discounts.some(d => d.type === "percent" && new arithmetic(d.value).gt(100)) ||
      (p.tax.treatment === "exclusive_percent" && new arithmetic(p.tax.rate).gt(100)) || p.billing.eligibleOrderStates.includes("cancelled"))
    throw Object.assign(new Error("Unsupported billing policy value"), { statusCode: 400, code: "BILLING_POLICY_INVALID" });
  stableDraftJson(p);
  return p;
}
/** Exact bounded arithmetic; every choice is explicit in independently approved policy. */
export function calculateAcceptedPrice(p: BillingPolicy, base: string) {
  p = parseBillingPolicy(p);
  base = exact.parse(base);
  const mode = rounding[p.rounding], round = (v: Decimal.Value) => new arithmetic(v).toDecimalPlaces(p.precision, mode);
  const components: Array<{ type: string; code: string; amount: string; basis?: string }> = [];
  const add = (type: string, code: string, v: Decimal.Value, basis?: string) => {
    const amount = round(v); components.push({ type, code, amount: amount.toFixed(p.precision), ...(basis ? { basis } : {}) }); return amount;
  };
  let subtotal = add("base_tariff", "tariff", base);
  for (const fee of p.fees) subtotal = subtotal.plus(add("additional_fee", fee.service, fee.amount));
  const discount = () => {
    for (const d of p.discounts) {
      const reduction = d.type === "flat" ? new arithmetic(d.value) : subtotal.times(d.value).div(100);
      const amount = add("discount", d.code, reduction, subtotal.toFixed(p.precision));
      if (amount.gt(subtotal)) throw Object.assign(new Error("Discount exceeds charge basis"), { statusCode: 409, code: "BILLING_CALCULATION_REJECTED" });
      subtotal = subtotal.minus(amount);
    }
  };
  const tax = () => { const basis = subtotal.toFixed(p.precision);
    subtotal = subtotal.plus(add("tax", p.tax.treatment, p.tax.treatment === "exclusive_percent" ? subtotal.times(p.tax.rate).div(100) : "0", basis)); };
  if (p.calculationOrder === "discount_then_tax") { discount(); tax(); } else { tax(); discount(); }
  if (subtotal.isNegative() || subtotal.gte("10000000000000000")) throw Object.assign(new Error("Unsupported accepted total"), { statusCode: 409, code: "BILLING_CALCULATION_REJECTED" });
  return { components, total: subtotal.toFixed(p.precision), currency: p.currency, requiresIndependentApproval: p.discounts.length > 0 };
}
