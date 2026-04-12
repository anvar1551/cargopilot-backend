"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripe = void 0;
exports.requireStripe = requireStripe;
const stripe_1 = __importDefault(require("stripe"));
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const keyPreview = stripeSecretKey ? stripeSecretKey.slice(0, 8) : "(no-key)";
console.log("Stripe key prefix:", keyPreview);
exports.stripe = stripeSecretKey
    ? new stripe_1.default(stripeSecretKey, {
        apiVersion: "2025-10-29.clover",
    })
    : null;
function requireStripe() {
    if (!exports.stripe) {
        throw new Error("STRIPE_SECRET_KEY not configured");
    }
    return exports.stripe;
}
