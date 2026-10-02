import {listIntegrationProviderConfigurationsForActor} from "../../src/modules/integrations-core/application/integration-admin.service";

import {listTemplateConfigurationsForActor,listRoutingConfigurationsForActor} from "../../src/modules/integrations-core/application/routing-configuration-read";
jest.mock("../../src/modules/integrations-core/application/routing-configuration-read",()=>({listTemplateConfigurationsForActor:jest.fn(),listRoutingConfigurationsForActor:jest.fn()}));
import {listRouteTemplatesForActor,getRouteTemplateForActor,createRouteTemplateForActor,updateRouteTemplateForActor,deleteRouteTemplateForActor} from "../../src/modules/integrations-core/application/route-template.service";
import {createCarrierRoutingRuleForActor,updateCarrierRoutingRuleForActor,deleteCarrierRoutingRuleForActor,listCarrierRoutingRulesForActor} from "../../src/modules/integrations-core/application/carrier-routing.service";
const mockWebhookClose = jest.fn(async () => undefined);
jest.mock("../../src/modules/integrations-core/application/webhook-database", () => ({ closeIntegrationWebhookDatabase: () => mockWebhookClose() }));
import { replayIntegrationOutboxForActor, retryIntegrationOutboxNowForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
jest.mock("../../src/modules/identity-access/transport/fastify-auth", () => ({ fastifyAuth: () => async () => undefined }));
jest.mock("../../src/modules/integrations-core/application/integration-admin.service", () => ({ listIntegrationWebhookEventsForActor: jest.fn(), listIntegrationCanonicalEventsForActor: jest.fn(), listIntegrationOutboxForActor: jest.fn(), listIntegrationOutboxAttemptsForActor: jest.fn(), listIntegrationProvidersForActor: jest.fn(), listIntegrationProviderConfigurationsForActor: jest.fn(), replayIntegrationOutboxForActor: jest.fn(), retryIntegrationOutboxNowForActor: jest.fn(), upsertIntegrationProviderForActor: jest.fn(), rotateIntegrationProviderSecretForActor: jest.fn(), deleteIntegrationProviderForActor: jest.fn(), updateIntegrationProviderStatusForActor: jest.fn() }));
jest.mock("../../src/modules/integrations-core/application/carrier-routing.service", () => ({createCarrierRoutingRuleForActor:jest.fn(),updateCarrierRoutingRuleForActor:jest.fn(),deleteCarrierRoutingRuleForActor:jest.fn(),listCarrierRoutingRulesForActor:jest.fn()}));
jest.mock("../../src/modules/integrations-core/application/route-template.service", () => ({listRouteTemplatesForActor:jest.fn(),getRouteTemplateForActor:jest.fn(),createRouteTemplateForActor:jest.fn(),updateRouteTemplateForActor:jest.fn(),deleteRouteTemplateForActor:jest.fn()}));
const mockWebhookIngest = jest.fn();
jest.mock("../../src/modules/integrations-core/application/webhook-gateway.service", () => ({ createWebhookGatewayService: () => ({ ingest: mockWebhookIngest }) }));
jest.mock("../../src/modules/integrations-core/infrastructure/provider-webhook-verifier.resolver", () => ({}));
jest.mock("../../src/modules/integrations-core/infrastructure/webhook-events.repo", () => ({}));
jest.mock("../../src/modules/integrations-core/infrastructure/canonical-event.repo", () => ({}));
import Fastify from "fastify";
import routes from "../../src/modules/integrations-core/transport/fastify-routes";
import { listIntegrationProvidersForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
import { listIntegrationWebhookEventsForActor, listIntegrationCanonicalEventsForActor, listIntegrationOutboxForActor, listIntegrationOutboxAttemptsForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
import { upsertIntegrationProviderForActor, rotateIntegrationProviderSecretForActor, deleteIntegrationProviderForActor, updateIntegrationProviderStatusForActor } from "../../src/modules/integrations-core/application/integration-admin.service";
beforeEach(() => jest.clearAllMocks());
it.each([400, 403, 404, 500])("provider list error %s exposes no database or credential detail", async statusCode => {
  const app = Fastify();
  try {
    await app.register(routes);
    jest.mocked(listIntegrationProvidersForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode }));
    const response = await app.inject({ method: "GET", url: "/providers" });
    expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY");
  } finally { await app.close(); }
});
it("valid paginated query retains its transport contract", async () => {
  const app = Fastify();
  try {
    await app.register(routes);
    const expected = { data: [], total: 0, pageInfo: { limit: 2, hasNextPage: false, nextCursor: null } };
    jest.mocked(listIntegrationProvidersForActor).mockResolvedValue(expected);
    const response = await app.inject({ method: "GET", url: "/providers?limit=2&domain=carrier&environment=sandbox" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(expected);
    expect(listIntegrationProvidersForActor).toHaveBeenCalledWith(expect.objectContaining({ limit: 2, domain: "carrier", environment: "sandbox" }));
  } finally { await app.close(); }
});
it("invalid pagination rejects before service work", async () => {
  const app = Fastify();
  try {
    await app.register(routes);
    const response = await app.inject({ method: "GET", url: "/providers?limit=101" });
    expect(response.statusCode).toBe(400); expect(listIntegrationProvidersForActor).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it.each([
  ["POST","/providers",upsertIntegrationProviderForActor,"INTEGRATION_CONFIGURATION_WORKFLOW_REQUIRED",{companyId:"10000000-0000-4000-8000-000000000001",domain:"carrier",providerCode:"sandbox",environment:"sandbox"}],
  ["PATCH","/providers/10000000-0000-4000-8000-000000000001/status",updateIntegrationProviderStatusForActor,"INTEGRATION_FINANCE_CONFIGURATION_APPROVAL_REQUIRED",{status:"paused"}],
  ["DELETE","/providers/10000000-0000-4000-8000-000000000001",deleteIntegrationProviderForActor,"INTEGRATION_PROVIDER_HISTORY_REQUIRED",undefined],
  ["POST","/providers/10000000-0000-4000-8000-000000000001/rotate-secret",rotateIntegrationProviderSecretForActor,"INTEGRATION_CONFIGURATION_WORKFLOW_REQUIRED",{secretPayload:"synthetic"}],
] as const)("%s provider mutation returns a safe explicit containment contract",async(method,url,handler,code,payload)=>{
  const app=Fastify();try{
    await app.register(routes);jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:409,code}));
    const response=await app.inject({method,url,payload});expect(response.statusCode).toBe(409);expect(response.json().code).toBe(code);expect(response.body).not.toContain("PRIVATE-CANARY");
    expect(handler).toHaveBeenCalledTimes(1);
  }finally{await app.close();}
});
it.each([["replay",replayIntegrationOutboxForActor],["retry-now",retryIntegrationOutboxNowForActor]] as const)("manual %s exposes a safe unavailable contract",async(action,handler)=>{
  const app=Fastify();try{
    await app.register(routes);jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:409,code:"INTEGRATION_OUTBOX_RECOVERY_REQUIRED"}));
    const response=await app.inject({method:"POST",url:`/outbox/10000000-0000-4000-8000-000000000001/${action}`});
    expect(response.statusCode).toBe(409);expect(response.json().code).toBe("INTEGRATION_OUTBOX_RECOVERY_REQUIRED");expect(response.body).not.toContain("PRIVATE-CANARY");expect(handler).toHaveBeenCalledTimes(1);
  }finally{await app.close();}
});

it.each([400, 403, 404, 500])("outbox and attempt read errors %s expose no private diagnostics", async statusCode => {
  const app = Fastify(); try {
    await app.register(routes);
    for (const [url, handler] of [["/outbox", listIntegrationOutboxForActor],
      ["/outbox/10000000-0000-4000-8000-000000000001/attempts", listIntegrationOutboxAttemptsForActor]] as const) {
      jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode }));
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY");
    }
  } finally { await app.close(); }
});
it("outbox capacity has a safe narrowing response, not partial totals", async () => {
  const app = Fastify(); try {
    await app.register(routes); jest.mocked(listIntegrationOutboxForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), {
      statusCode: 409, code: "INTEGRATION_READ_CAPACITY" }));
    const response = await app.inject({ method: "GET", url: "/outbox" });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("INTEGRATION_READ_CAPACITY"); expect(response.body).not.toContain("PRIVATE-CANARY");
  } finally { await app.close(); }
});
it("outbox metadata list and attempt array retain response envelopes", async () => {
  const app = Fastify(); try {
    await app.register(routes); const page = { items: [], total: 0, page: 2, limit: 3 };
    jest.mocked(listIntegrationOutboxForActor).mockResolvedValue(page);
    jest.mocked(listIntegrationOutboxAttemptsForActor).mockResolvedValue([]);
    const response = await app.inject({ method: "GET", url: "/outbox?page=2&limit=3&domain=carrier" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(page);
    expect(listIntegrationOutboxForActor).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 3, domain: "carrier" }));
    const details = await app.inject({ method: "GET", url: "/outbox/10000000-0000-4000-8000-000000000001/attempts?limit=2" });
    expect(details.statusCode).toBe(200); expect(details.json()).toEqual([]);
  } finally { await app.close(); }
});

it.each([400, 403, 404, 500])("event read errors %s suppress internal diagnostics", async statusCode => {
  const app = Fastify(); try {
    await app.register(routes);
    for (const [url, handler] of [["/webhook-events", listIntegrationWebhookEventsForActor],
      ["/canonical-events", listIntegrationCanonicalEventsForActor]] as const) {
      jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode }));
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(statusCode); expect(response.body).not.toContain("PRIVATE-CANARY");
    }
  } finally { await app.close(); }
});
it("event list envelopes and validated transport filters remain supported", async () => {
  const app = Fastify(); try {
    await app.register(routes); const page = { items: [], total: 0, page: 1, limit: 2 };
    jest.mocked(listIntegrationWebhookEventsForActor).mockResolvedValue(page);
    jest.mocked(listIntegrationCanonicalEventsForActor).mockResolvedValue(page);
    for (const url of ["/webhook-events?limit=2&providerCode=sandbox", "/canonical-events?limit=2&status=processed"]) {
      const response = await app.inject({ method: "GET", url }); expect(response.statusCode).toBe(200); expect(response.json()).toEqual(page);
    }
    expect(listIntegrationCanonicalEventsForActor).toHaveBeenCalledWith(expect.objectContaining({ status: "processed", limit: 2 }));
  } finally { await app.close(); }
});
it.each([403, 409, 503, 500])("ingress persistence error %s never exposes diagnostics or acknowledges acceptance", async statusCode => {
  const app = Fastify(); try {
    await app.register(routes); mockWebhookIngest.mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"), { statusCode,
      ...(statusCode === 503 ? { code: "WEBHOOK_INGRESS_INCOMPLETE" } : {}) }));
    const response = await app.inject({ method: "POST", url: "/webhooks/synthetic", payload: '{"eventId":"synthetic"}', headers: { "content-type": "application/json" } });
    expect(response.statusCode).toBe(statusCode); expect(response.json().status).toBe("rejected"); expect(response.body).not.toContain("PRIVATE-CANARY");
    if (statusCode === 503) expect(response.json().code).toBe("WEBHOOK_INGRESS_INCOMPLETE");
  } finally { await app.close(); }
});

it.each(["WEBHOOK_INGRESS_CAPACITY","WEBHOOK_INGRESS_DATABASE_UNAVAILABLE"])("webhook retryable limit %s is sanitized and never acknowledged", async code => {
  const app=Fastify();try {
    await app.register(routes); mockWebhookIngest.mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:503,code}));
    const response=await app.inject({method:"POST",url:"/webhooks/synthetic",payload:"{}",headers:{"content-type":"application/json"}});
    expect(response.statusCode).toBe(503);expect(response.json()).toMatchObject({status:"rejected",code});expect(response.body).not.toContain("PRIVATE-CANARY");
  }finally{await app.close();expect(mockWebhookClose).toHaveBeenCalledTimes(1);}
});
it("HTTP raw-body bound rejects before gateway work", async () => {
  const app=Fastify();try {
    await app.register(routes);const response=await app.inject({method:"POST",url:"/webhooks/synthetic",payload:"x".repeat(1024*1024+1),headers:{"content-type":"application/json"}});
    expect(response.statusCode).toBe(413);expect(mockWebhookIngest).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it.each([400,403,404,500])("routing inventory error %s suppresses private diagnostics",async statusCode=>{const app=Fastify();try{await app.register(routes);jest.mocked(listCarrierRoutingRulesForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode}));const response=await app.inject({method:"GET",url:"/carrier-routing-rules"});expect(response.statusCode).toBe(statusCode);expect(response.body).not.toContain("PRIVATE-CANARY");}finally{await app.close();}});
it("routing capacity returns explicit narrow-filter response",async()=>{const app=Fastify();try{await app.register(routes);jest.mocked(listCarrierRoutingRulesForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:409,code:"INTEGRATION_READ_CAPACITY"}));const response=await app.inject({method:"GET",url:"/carrier-routing-rules"});expect(response.statusCode).toBe(409);expect(response.json().code).toBe("INTEGRATION_READ_CAPACITY");expect(response.body).not.toContain("PRIVATE-CANARY");}finally{await app.close();}});

it.each([403,404,500,409])("routing mutation errors %s use a sanitized controlled-workflow boundary",async statusCode=>{
 const app=Fastify();try{await app.register(routes);const id="10000000-0000-4000-8000-000000000001";
 for(const [method,url,handler,payload] of [["POST","/carrier-routing-rules",createCarrierRoutingRuleForActor,{companyId:id,providerId:id,name:"Synthetic"}],["PATCH","/carrier-routing-rules/"+id,updateCarrierRoutingRuleForActor,{autoBook:true}],["DELETE","/carrier-routing-rules/"+id,deleteCarrierRoutingRuleForActor,undefined]] as const){
 jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode,...(statusCode===409?{code:"INTEGRATION_ROUTING_CONFIGURATION_WORKFLOW_REQUIRED"}:{})}));
 const response=await app.inject({method,url,payload});expect(response.statusCode).toBe(statusCode);expect(response.body).not.toContain("PRIVATE-CANARY");if(statusCode===409)expect(response.json().code).toBe("INTEGRATION_ROUTING_CONFIGURATION_WORKFLOW_REQUIRED");}
 }finally{await app.close();}
});

it.each([listRouteTemplatesForActor,getRouteTemplateForActor])("template read exceptions do not expose private details",async operation=>{
 const app=Fastify();try{await app.register(routes);jest.mocked(operation).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:403}));const response=await app.inject({method:"GET",url:operation===listRouteTemplatesForActor?"/route-templates":"/route-templates/00000000-0000-4000-8000-000000000001"});expect(response.statusCode).toBe(403);expect(response.body).not.toContain("PRIVATE-CANARY");}finally{await app.close();}
});
it.each([createRouteTemplateForActor,updateRouteTemplateForActor,deleteRouteTemplateForActor])("template mutation communicates workflow containment without diagnostics",async operation=>{
 const app=Fastify();try{await app.register(routes);jest.mocked(operation).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode:409,code:"INTEGRATION_ROUTING_CONFIGURATION_WORKFLOW_REQUIRED"}));
 const create=operation===createRouteTemplateForActor,remove=operation===deleteRouteTemplateForActor;
 const response=await app.inject({method:create?"POST":remove?"DELETE":"PATCH",url:create?"/route-templates":"/route-templates/00000000-0000-4000-8000-000000000001",...(!remove?{payload:create?{companyId:"00000000-0000-4000-8000-000000000001",name:"Synthetic",legs:[{sequence:1,legCode:"synthetic",mode:"road"}]}:{name:"Synthetic"}}:{})});
 expect(response.statusCode).toBe(409);expect(response.json().code).toBe("INTEGRATION_ROUTING_CONFIGURATION_WORKFLOW_REQUIRED");expect(response.body).not.toContain("PRIVATE-CANARY");}finally{await app.close();}
});

it.each([400,403,404,500])("configuration version error %s is credential safe",async statusCode=>{const app=Fastify();try{await app.register(routes);jest.mocked(listIntegrationProviderConfigurationsForActor).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode}));const r=await app.inject({method:"GET",url:"/providers/10000000-0000-4000-8000-000000000001/configurations"});expect(r.statusCode).toBe(statusCode);expect(r.body).not.toContain("PRIVATE-CANARY");}finally{await app.close();}});
it("configuration version transport rejects client ownership fields",async()=>{const app=Fastify();try{await app.register(routes);const r=await app.inject({method:"GET",url:"/providers/10000000-0000-4000-8000-000000000001/configurations?tenantId=foreign"});expect(r.statusCode).toBe(400);expect(listIntegrationProviderConfigurationsForActor).not.toHaveBeenCalled();}finally{await app.close();}});
it("configuration version transport returns the minimal paginated contract",async()=>{const app=Fastify();try{await app.register(routes);jest.mocked(listIntegrationProviderConfigurationsForActor).mockResolvedValue({providerId:"id",currentRevision:0,currentConfigurationId:null,data:[],total:0,pageInfo:{limit:25,hasNextPage:false,nextCursor:null}});const r=await app.inject({method:"GET",url:"/providers/10000000-0000-4000-8000-000000000001/configurations"});expect(r.statusCode).toBe(200);expect(r.json().currentRevision).toBe(0);}finally{await app.close();}});

it.each([["/route-templates",listTemplateConfigurationsForActor],["/carrier-routing-rules",listRoutingConfigurationsForActor]] as const)("configuration history %s retains safe bounded transport contract",async(path,handler)=>{
 const app=Fastify();try{await app.register(routes);const expected={resourceId:"10000000-0000-4000-8000-000000000001",data:[],total:0,currentRevision:0,currentConfigurationId:null,pageInfo:{limit:2,hasNextPage:false,nextCursor:null}};
 jest.mocked(handler).mockResolvedValue(expected);
 const response=await app.inject({method:"GET",url:path+"/"+expected.resourceId+"/configurations?limit=2"});
 expect(response.statusCode).toBe(200);expect(response.json()).toEqual(expected);expect(handler).toHaveBeenCalledWith(expect.objectContaining({resourceId:expected.resourceId,limit:2}));
 }finally{await app.close();}
});
it.each([["/route-templates",listTemplateConfigurationsForActor],["/carrier-routing-rules",listRoutingConfigurationsForActor]] as const)("configuration history %s rejects client ownership and limits before service work",async(path,handler)=>{
 const app=Fastify();try{await app.register(routes);for(const query of ["tenantId=foreign","companyId=foreign","limit=101","cursor=invalid"]){
 const response=await app.inject({method:"GET",url:path+"/10000000-0000-4000-8000-000000000001/configurations?"+query});expect(response.statusCode).toBe(400);expect(handler).not.toHaveBeenCalled();
 }}finally{await app.close();}
});
it.each([400,403,404,500])("configuration history errors %s omit private diagnostics",async statusCode=>{
 const app=Fastify();try{await app.register(routes);for(const [path,handler] of [["/route-templates",listTemplateConfigurationsForActor],["/carrier-routing-rules",listRoutingConfigurationsForActor]] as const){
 jest.mocked(handler).mockRejectedValue(Object.assign(Error("PRIVATE-CANARY"),{statusCode}));const response=await app.inject({method:"GET",url:path+"/10000000-0000-4000-8000-000000000001/configurations"});
 expect(response.statusCode).toBe(statusCode);expect(response.body).not.toContain("PRIVATE-CANARY");
 }}finally{await app.close();}
});
