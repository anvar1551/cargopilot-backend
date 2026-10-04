import Stripe from "stripe";
import { createRequire } from "node:module";

// Actual installed dependency behavior; synthetic inputs and an in-memory HTTP
// handler only. No application startup/configuration or service connections.
const qs = require("qs");
const minimatch = require("minimatch");
const expand = require("brace-expansion");
const watcherRequire = createRequire(require.resolve("anymatch"));
const jestRequire = createRequire(require.resolve("jest-util"));

it("preserves actual Stripe nested checkout encoding and durable request identity", async () => {
  const seen: Array<{ body: string; headers: Record<string, string> }> = [];
  const httpClient = Stripe.createFetchHttpClient(async (_url: string, init?: RequestInit) => {
    seen.push({ body: String(init?.body), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify({ id: "synthetic-session", object: "checkout.session" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const stripe = new Stripe("synthetic-test-only", { httpClient, maxNetworkRetries: 0 });
  const result = await stripe.checkout.sessions.create({
    mode: "payment", line_items: [{ price_data: {
      currency: "usd", unit_amount: 120025,
      product_data: { name: "Synthetic & scoped order" },
    }, quantity: 1 }], metadata: { orderId: "synthetic-order", companyId: "synthetic-company" },
    success_url: "https://example.invalid/confirmed", cancel_url: "https://example.invalid/cancelled",
  }, { idempotencyKey: "synthetic-company:synthetic-intent" });
  expect(result.id).toBe("synthetic-session");
  expect(seen).toHaveLength(1);
  const body = new URLSearchParams(seen[0].body);
  expect(body.get("line_items[0][price_data][unit_amount]")).toBe("120025");
  expect(body.get("line_items[0][price_data][product_data][name]")).toBe("Synthetic & scoped order");
  expect(body.get("metadata[companyId]")).toBe("synthetic-company");
  expect(Object.entries(seen[0].headers).find(([key]) => key.toLowerCase() === "idempotency-key")?.[1])
    .toBe("synthetic-company:synthetic-intent");
});

it("handles bounded nullish comma-array serialization without the reported crash", () => {
  expect(() => qs.stringify({ values: [null, undefined, "a&b"] }, {
    arrayFormat: "comma", encodeValuesOnly: true,
  })).not.toThrow();
  expect(qs.parse("a[0]=one&a[1]=two", { arrayLimit: 2, throwOnLimitExceeded: true }))
    .toEqual({ a: ["one", "two"] });
  expect(() => qs.parse("a[]=one&a[]=two", { arrayLimit: 1, throwOnLimitExceeded: true }))
    .toThrow();
});

it("preserves minimatch and brace expansion for bounded development file patterns", () => {
  expect(expand("src/{orders,payments}/*.ts")).toEqual(["src/orders/*.ts", "src/payments/*.ts"]);
  const paths = ["src/orders/create.ts", "src/payments/checkout.ts", "src/orders/.private.ts", "dist/orders/create.js"];
  expect(paths.filter(path => minimatch(path, "src/{orders,payments}/*.ts")))
    .toEqual(paths.slice(0, 2));
  expect(require("glob").hasMagic("src/{orders,payments}/*.ts")).toBe(true);
});

it.each([["watcher", watcherRequire], ["jest", jestRequire]] as const)(
  "%s picomatch preserves POSIX classes and exclusions", (_label, load) => {
    const match = load("picomatch");
    expect(match("[[:digit:]].ts")("1.ts")).toBe(true);
    expect(match("[[:digit:]].ts")("x.ts")).toBe(false);
    expect(match("**/*.ts", { ignore: "**/dist/**" })("src/order.ts")).toBe(true);
    expect(match("**/*.ts", { ignore: "**/dist/**" })("dist/order.ts")).toBe(false);
  },
);

it("preserves ts-node's diff patch application on bounded synthetic text", () => {
  const diff = require("diff");
  const patch = diff.createPatch("synthetic", "before\n", "after\n");
  expect(diff.applyPatch("before\n", patch)).toBe("after\n");
  expect(diff.applyPatch("conflicting\n", patch)).toBe(false);
});
