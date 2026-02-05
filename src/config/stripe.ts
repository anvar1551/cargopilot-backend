import Stripe from "stripe";

const keyPreview = process.env.STRIPE_SECRET_KEY
  ? process.env.STRIPE_SECRET_KEY.slice(0, 8)
  : "(no-key)";
console.log("Stripe key prefix:", keyPreview);

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-10-29.clover",
});
