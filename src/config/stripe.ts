import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const keyPreview = stripeSecretKey ? stripeSecretKey.slice(0, 8) : "(no-key)";
console.log("Stripe key prefix:", keyPreview);

export const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, {
      apiVersion: "2025-10-29.clover",
    })
  : null;

export function requireStripe() {
  if (!stripe) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }

  return stripe;
}
