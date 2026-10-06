// DOM-05 supersedes the former broad-role/mirror-backed custody contract.
// Actual authorization, money, custody and concurrency are exercised by
// cash-capability-postgres.integration.test.ts; these are adapter-only checks.
const mockExecute=jest.fn(),mockRead=jest.fn();
jest.mock("../../src/modules/orders-core/cash/restricted-cash.service",()=>({executeRestrictedCash:mockExecute,readRestrictedCash:mockRead}));
jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:{}}));
jest.mock("../../src/config/redis",()=>({getRedisClient:async()=>null}));
import {randomUUID} from "node:crypto";
import {collectOrderCash,handoffOrderCash,settleOrderCash} from "../../src/modules/orders-core/cash/custody.service";
import {listCashQueueForActor,getCashQueueSummaryForActor} from "../../src/modules/orders-core/cash/collection.service";
const actor={id:randomUUID()},input=()=>({actor,orderId:randomUUID(),operationId:randomUUID(),kind:"service_charge"});
beforeEach(()=>{jest.clearAllMocks();mockExecute.mockResolvedValue({state:'held',amount:'100'});mockRead.mockResolvedValue({items:[]});});
it.each([[collectOrderCash,'collect'],[handoffOrderCash,'offer'],[settleOrderCash,'settle']] as const)("compatibility adapter forwards exact context and immutable intent to mandatory restricted %s service",async(fn,action)=>{
 const v=input();await fn(v);const {actor:who,...intent}=v;expect(mockExecute).toHaveBeenCalledWith(who,action,intent);
});
it.each([collectOrderCash,handoffOrderCash,settleOrderCash])("supplied amount rejects before invoking any business mutation",async fn=>{expect(()=>fn({...input(),amount:100})).toThrow('CALLER_MONETARY_AUTHORITY_FORBIDDEN');expect(mockExecute).not.toHaveBeenCalled();});
it("handoff retains authoritative expected event and never changes offer to implicit acceptance",async()=>{const v={...input(),expectedEventId:randomUUID(),recipientMembershipId:randomUUID(),recipientWarehouseId:randomUUID()};await handoffOrderCash(v);const {actor:who,...intent}=v;expect(mockExecute).toHaveBeenCalledWith(who,'offer',intent);});
it("restricted service rejection cannot fall back to broad legacy authorization",async()=>{mockExecute.mockRejectedValue(Error('CASH_CAPABILITY_REQUIRED'));await expect(collectOrderCash(input())).rejects.toThrow('CASH_CAPABILITY_REQUIRED');expect(mockExecute).toHaveBeenCalledTimes(1);});
it("legacy pageSize alone maps to bounded read, never a global legacy query",async()=>{await listCashQueueForActor({actor,filters:{pageSize:20}});expect(mockRead).toHaveBeenCalledWith(actor,{limit:20});});
it.each([{page:1},{statuses:['held']},{companyId:randomUUID()},{from:'2026-01-01'}])("legacy/global filters reject without reads %j",async filters=>{await expect(listCashQueueForActor({actor,filters})).rejects.toThrow('CASH_CURSOR_CONTRACT_REQUIRED');expect(mockRead).not.toHaveBeenCalled();});
it("old mixed-currency Float summary is unavailable, rather than an empty success",async()=>{await expect(getCashQueueSummaryForActor({actor})).rejects.toThrow('CASH_EXACT_SUMMARY_UNAVAILABLE');expect(mockRead).not.toHaveBeenCalled();});
