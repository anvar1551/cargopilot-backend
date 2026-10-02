import { createWebhookGatewayService } from "../../src/modules/integrations-core/application/webhook-gateway.service";
import { withIntegrationWebhookAdmission, integrationWebhookBodyLimit } from "../../src/modules/integrations-core/application/webhook-admission";
import { createIntegrationWebhookDatabase, getIntegrationWebhookDatabase } from "../../src/modules/integrations-core/application/webhook-database";

it("capacity rejects before resolver verification or persistence, retaining permits for unsettled work", async () => {
  let release!: () => void;
  const gate = new Promise<null>(resolve => { release = () => resolve(null); });
  const resolver = { resolve: jest.fn(() => gate) }, events = { hasProcessed: jest.fn(), persistVerified: jest.fn() };
  const service = createWebhookGatewayService({ providerVerifiers: resolver, events });
  const input = { providerCode: "synthetic", rawBody: "{}", headers: {} };
  const pending = Array.from({length:8}, () => service.ingest(input));
  try {
    await expect(service.ingest(input)).rejects.toMatchObject({statusCode:503,code:"WEBHOOK_INGRESS_CAPACITY"});
    // A caller abandoning its response does not settle the underlying promise.
    await Promise.resolve(); await expect(service.ingest(input)).rejects.toMatchObject({code:"WEBHOOK_INGRESS_CAPACITY"});
    expect(resolver.resolve).toHaveBeenCalledTimes(8); expect(events.persistVerified).not.toHaveBeenCalled();
  } finally { release(); await Promise.allSettled(pending); }
  await expect(service.ingest(input)).resolves.toMatchObject({status:"rejected"});
});
it("a rejected operation releases only its own settled permit", async () => {
  await expect(withIntegrationWebhookAdmission(async () => { throw Error("synthetic-failure"); })).rejects.toThrow("synthetic-failure");
  await expect(withIntegrationWebhookAdmission(async () => "recovered")).resolves.toBe("recovered");
});
it("oversized UTF8 body rejects before any provider lookup and never persists", async () => {
  const resolver = {resolve:jest.fn()}, events = {hasProcessed:jest.fn(),persistVerified:jest.fn()};
  const service = createWebhookGatewayService({providerVerifiers:resolver,events});
  await expect(service.ingest({providerCode:"synthetic",rawBody:"é".repeat(integrationWebhookBodyLimit),headers:{}})).rejects.toMatchObject({statusCode:413});
  expect(resolver.resolve).not.toHaveBeenCalled(); expect(events.persistVerified).not.toHaveBeenCalled();
});
it("pool construction is lazy and declares bounded acquisition native statements and locks", async () => {
  const resource = createIntegrationWebhookDatabase("postgresql://synthetic:synthetic@127.0.0.1:1/synthetic");
  try {
    expect(resource.pool.totalCount).toBe(0); expect(resource.pool.waitingCount).toBe(0);
    expect(resource.pool.options).toMatchObject({max:8,connectionTimeoutMillis:1000,options:"-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000"});
  } finally { await resource.close(); }
});
it("missing bounded native transport and Accelerate-only configuration fail closed without connecting", () => {
  const prior = process.env; process.env = {NODE_ENV:"test"};
  try {
    expect(() => getIntegrationWebhookDatabase()).toThrow("Bounded webhook database unavailable");
    process.env = {NODE_ENV:"test",PRISMA_ACCELERATE_URL:"synthetic-unsupported",DATABASE_URL:"synthetic-not-used"};
    expect(() => getIntegrationWebhookDatabase()).toThrow("Bounded webhook database unavailable");
  } finally {process.env=prior;}
});
