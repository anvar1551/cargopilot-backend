jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/config/redis",()=>({getRedisPrefix:()=>"synthetic",getRedisClient:jest.fn(),withRedisTimeout:jest.fn()}));
jest.mock("../../src/modules/analytics-core/config/analyticsConfig",()=>({analyticsConfig:{logLevel:"debug",outbox:{batchSize:10,idleMs:1000,lockTtlSec:30,consumerId:"synthetic",leaderLockEnabled:false,enabled:true}}}));
jest.mock("../../src/modules/analytics-core/realtime/analyticsEvents",()=>({appendCargoPilotDomainEvent:jest.fn()}));
import {analyticsLogger} from "../../src/modules/analytics-core/config/analyticsLogger";
import {startAnalyticsOutboxPublisher} from "../../src/modules/analytics-core/infrastructure/analyticsOutboxPublisher";
import {appendCargoPilotDomainEvent} from "../../src/modules/analytics-core/realtime/analyticsEvents";
import {database as db} from "./fixtures";
const privateMarker="synthetic-private-endpoint-password-sql-value";
let error:jest.SpyInstance,warn:jest.SpyInstance,info:jest.SpyInstance;
beforeEach(()=>{jest.clearAllMocks();error=jest.spyOn(console,"error").mockImplementation(()=>undefined);warn=jest.spyOn(console,"warn").mockImplementation(()=>undefined);info=jest.spyOn(console,"log").mockImplementation(()=>undefined);});
afterEach(()=>{error.mockRestore();warn.mockRestore();info.mockRestore();jest.useRealTimers();});
it.each([new Error(privateMarker),{message:privateMarker,name:privateMarker},privateMarker])("analytics error diagnostics contain neither arbitrary exception text nor names (%#)",input=>{analyticsLogger.error("Worker operation failed",input);const line=error.mock.calls[0][0];expect(line).not.toContain(privateMarker);expect(JSON.parse(line).error).toEqual({code:"ANALYTICS_OPERATION_FAILED"});});
it("throttled diagnostics preserve safe operation label and suppression count",()=>{analyticsLogger.throttledWarn("synthetic-throttle","Worker lookup failed",{error:new Error(privateMarker),meta:{operation:"lookup"},throttleMs:60000});analyticsLogger.throttledWarn("synthetic-throttle","Worker lookup failed",{error:privateMarker,throttleMs:60000});expect(warn).toHaveBeenCalledTimes(1);expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({message:"Worker lookup failed",meta:{operation:"lookup",suppressed:0},error:{code:"ANALYTICS_OPERATION_FAILED"}});expect(JSON.stringify(warn.mock.calls)).not.toContain(privateMarker);});
it("publisher persists only a bounded failure code and retains pending retry state",async()=>{
  jest.useFakeTimers();const outbox=(db as any).analyticsDomainEventOutbox;const row={id:"synthetic-row",eventId:"synthetic-event",type:"order_status_changed",tenantScope:"tenant:synthetic:company:synthetic",entityId:"synthetic-order",occurredAt:new Date(),payload:{},schemaVersion:1};
  outbox.findMany.mockResolvedValueOnce([row]).mockResolvedValue([]);outbox.update.mockResolvedValue({});(appendCargoPilotDomainEvent as jest.Mock).mockRejectedValue(new Error(privateMarker));
  // Run one iteration only: fake clock is never advanced, so the next empty-batch sleep cannot resume.
  void startAnalyticsOutboxPublisher();for(let n=0;n<12;n++)await Promise.resolve();
  expect(appendCargoPilotDomainEvent).toHaveBeenCalledTimes(1);expect(outbox.update).toHaveBeenCalledTimes(1);expect(outbox.update).toHaveBeenCalledWith({where:{id:row.id},data:{attempts:{increment:1},lastError:"ANALYTICS_OUTBOX_PUBLISH_FAILED"}});expect(outbox.update.mock.calls[0][0].data).not.toHaveProperty("publishedAt");expect(JSON.stringify(outbox.update.mock.calls)).not.toContain(privateMarker);expect(jest.getTimerCount()).toBe(1);jest.clearAllTimers();
});
