jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/identity-access",()=>({authorize:jest.fn(),buildOrderScopeWhere:jest.fn()}));
jest.mock("../../src/modules/analytics-core/realtime/analyticsEvents",()=>({publishCargoPilotDomainEvent:jest.fn(),buildCargoPilotDomainEvent:jest.fn()}));
jest.mock("../../src/config/redis",()=>({getRedisClient:jest.fn(),createRedisClient:jest.fn()}));
import {emitAnalyticsInvalidationForMutation} from "../../src/middleware/analyticsInvalidate";
import {emitMutationInvalidation} from "../../src/modules/orders-core/transport/shared";
import {publishCargoPilotDomainEvent,buildCargoPilotDomainEvent} from "../../src/modules/analytics-core/realtime/analyticsEvents";
import {getRedisClient,createRedisClient} from "../../src/config/redis";
import {expectNoDatabaseCalls} from "./fixtures";
beforeEach(()=>jest.clearAllMocks());
function noEffects(){expect(publishCargoPilotDomainEvent).not.toHaveBeenCalled();expect(buildCargoPilotDomainEvent).not.toHaveBeenCalled();expect(getRedisClient).not.toHaveBeenCalled();expect(createRedisClient).not.toHaveBeenCalled();expectNoDatabaseCalls();}
it.each(["order_mutation","cash_mutation"] as const)("legacy %s does not produce global or inferred tenant events",async reason=>{await expect(emitAnalyticsInvalidationForMutation({reason})).resolves.toBeUndefined();noEffects();});
it.each(["order_mutation","cash_mutation"] as const)("existing %s wrapper remains successful without Redis or business effects",async reason=>{await expect(emitMutationInvalidation(reason)).resolves.toBeUndefined();noEffects();});
it("unsupported caller authority cannot enable global publication",async()=>{await emitAnalyticsInvalidationForMutation({reason:"order_mutation",tenantId:"forged",companyId:"forged",role:"manager"} as any);noEffects();});
