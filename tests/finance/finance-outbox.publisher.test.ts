const mockQuery = jest.fn(), mockExecute = jest.fn(), mockUnsafe = jest.fn(), mockFind = jest.fn(), mockUpdate = jest.fn();
const mockResolve = jest.fn(), mockHash = jest.fn(), mockXadd = jest.fn(), mockTimeout = jest.fn();
const mockDb:any = {$queryRaw:mockQuery,$executeRaw:mockExecute,$executeRawUnsafe:mockUnsafe,financeDomainEventOutbox:{findUniqueOrThrow:mockFind,update:mockUpdate}};
jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:{$transaction:(work:any)=>work(mockDb),$executeRaw:mockExecute}}));
jest.mock("../../src/config/redis",()=>({getRedisPrefix:()=>"test",getRedisClient:async()=>({xadd:mockXadd}),withRedisTimeout:(...args:any[])=>mockTimeout(...args)}));
jest.mock("../../src/modules/finance-core/infrastructure/finance-outbox-authority",()=>({financePublicationHash:(row:any)=>mockHash(row),resolveFinancePublication:(...args:any[])=>mockResolve(...args),rejectFinancePublication:()=>{throw Object.assign(Error("denied"),{code:"FINANCE_OUTBOX_SOURCE_REJECTED"});}}));
import {claimFinanceOutboxBatch,prepareFinanceDispatch,completeFinanceDispatch,processFinanceOutboxBatchOnce,startFinanceOutboxPublisher} from "../../src/modules/finance-core/infrastructure/finance-outbox.publisher";
import {logFinanceOutboxFailure} from "../../src/modules/finance-core/infrastructure/finance-outbox-diagnostics";
const claim={id:"00000000-0000-7000-8000-000000000001",claimToken:"00000000-0000-7000-8000-000000000002"};
const owner={tenantId:"tenant-a",companyId:"company-a",capability:"account_invalidation",accountId:"account-a",installationId:null,journalId:null};
const row={...claim,...owner,eventId:"event-a",acceptedAt:new Date(),occurredAt:new Date(),schemaVersion:1,contentHash:"hash",payloadJson:{},legalEntityId:"entity-a",aggregateType:"finance_account",aggregateId:"account-a",eventType:"finance.account.created"};
beforeEach(()=>{jest.resetAllMocks();mockQuery.mockResolvedValue([claim]);mockExecute.mockResolvedValue(1);mockUnsafe.mockResolvedValue(0);mockFind.mockResolvedValue(row);mockHash.mockReturnValue("hash");mockResolve.mockResolvedValue(owner);mockXadd.mockResolvedValue("1-0");mockTimeout.mockImplementation(async(_name:any,work:any)=>work());});
it("publishes only minimal reference after committed marker and exact confirmation",async()=>{
 expect(await processFinanceOutboxBatchOnce({consumerId:"untrusted",batchSize:10})).toEqual({claimed:1,published:1,failed:0,busy:false});
 const args=mockXadd.mock.calls[0],event=JSON.parse(args[args.length-1]);expect(event).toMatchObject({tenantScope:"tenant:tenant-a:company:company-a",legalEntityId:"entity-a",payload:{outboxId:claim.id,sourceId:"account-a"}});
 expect(event.payload).not.toHaveProperty("amount");expect(mockResolve).toHaveBeenCalledWith(mockDb,row,true);
 const commands=mockExecute.mock.calls.map(call=>call[0].join(""));expect(commands.some(sql=>sql.includes("'dispatching'"))).toBe(true);
});
it.each([0,2])("completion count %i cannot report durable success",async count=>{
 mockExecute.mockImplementation(async(strings:any)=>strings.join("").includes("'published'")?count:1);
 expect(await processFinanceOutboxBatchOnce()).toMatchObject({published:0,failed:1});expect(mockXadd).toHaveBeenCalledTimes(1);
 expect(mockExecute.mock.calls[mockExecute.mock.calls.length-1][0].join("")).toContain("reconciliation_required");
});
it("uncertain append becomes reconciliation without sensitive diagnostics or immediate replay",async()=>{
 mockXadd.mockRejectedValue(Error("synthetic-private-value"));
 expect(await processFinanceOutboxBatchOnce()).toMatchObject({published:0,failed:1});expect(mockXadd).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(mockExecute.mock.calls)).not.toContain("synthetic-private");expect(mockExecute.mock.calls[mockExecute.mock.calls.length-1][0].join("")).toContain("FINANCE_DISPATCH_UNCERTAIN");
});
it("expired or forged fence cannot read protected source or append",async()=>{mockQuery.mockResolvedValue([]);expect(await prepareFinanceDispatch(claim)).toBeNull();expect(mockFind).not.toHaveBeenCalled();expect(mockResolve).not.toHaveBeenCalled();expect(mockXadd).not.toHaveBeenCalled();});
it.each(["hash","owner","suspended"])("%s authority denial quarantines before transport",async kind=>{
 if(kind==="hash")mockHash.mockReturnValue("foreign");if(kind==="owner")mockResolve.mockResolvedValue({...owner,companyId:"foreign"});
 if(kind==="suspended")mockResolve.mockRejectedValue(Object.assign(Error("denied"),{code:"FINANCE_OUTBOX_SOURCE_REJECTED"}));
 expect(await processFinanceOutboxBatchOnce()).toMatchObject({published:0,failed:1});expect(mockXadd).not.toHaveBeenCalled();
 expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({publicationState:"quarantined",lastError:"FINANCE_SOURCE_REJECTED"})}));
});
it("database error before dispatch remains bounded pre-dispatch retryable",async()=>{
 mockResolve.mockRejectedValue(Error("synthetic-db-failure"));expect(await processFinanceOutboxBatchOnce()).toMatchObject({published:0,failed:1});
 expect(mockXadd).not.toHaveBeenCalled();expect(mockUpdate).not.toHaveBeenCalled();expect(mockExecute.mock.calls[mockExecute.mock.calls.length-1][0].join("")).toContain("FINANCE_PRE_DISPATCH_FAILED");
});
it("failed marker prevents append",async()=>{
 mockExecute.mockImplementation(async(strings:any)=>strings.join("").includes('"dispatchStartedAt"=NOW()')?0:1);
 expect(await processFinanceOutboxBatchOnce()).toMatchObject({published:0,failed:1});expect(mockXadd).not.toHaveBeenCalled();
});
it("timeout retains admission until the actual underlying command settles",async()=>{
 let finish!:()=>void;mockXadd.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
 mockTimeout.mockImplementation(async(_name:any,work:any)=>{void work();await Promise.resolve();await Promise.resolve();throw Error("deadline");});
 expect(await processFinanceOutboxBatchOnce()).toMatchObject({failed:1});expect(await processFinanceOutboxBatchOnce()).toMatchObject({busy:true,claimed:0});expect(mockXadd).toHaveBeenCalledTimes(1);
 finish();await new Promise<void>(resolve=>setImmediate(resolve));mockQuery.mockResolvedValue([]);expect(await processFinanceOutboxBatchOnce()).toMatchObject({busy:false,claimed:0});
});
it.each([0,11,NaN,1.5])("claim size %s rejected before database work",async size=>{await expect(claimFinanceOutboxBatch(size)).rejects.toThrow("Bounded");expect(mockQuery).not.toHaveBeenCalled();});
it("completion is token/state/expiry fenced",async()=>{expect(await completeFinanceDispatch(claim)).toBe(true);expect(mockExecute.mock.calls[0][0].join("")).toContain('"claimToken"=');expect(mockExecute.mock.calls[0][0].join("")).toContain('"leaseExpiresAt">');});
it.each(["loop","crash"] as const)("%s diagnostics remain static",phase=>{
 const output=jest.spyOn(console,"error").mockImplementation(()=>undefined);try{logFinanceOutboxFailure(phase);expect(JSON.parse(String(output.mock.calls[0][0])).error.code).toBe(phase==="loop"?"FINANCE_OUTBOX_LOOP_FAILED":"FINANCE_OUTBOX_WORKER_CRASHED");}finally{output.mockRestore();}
});
it("loop logs no arbitrary exception and abort stops admission",async()=>{
 jest.useFakeTimers();const controller=new AbortController(),output=jest.spyOn(console,"error").mockImplementation(()=>undefined);
 mockUnsafe.mockRejectedValue(Error("synthetic-private"));const work=startFinanceOutboxPublisher({signal:controller.signal});
 try{for(let n=0;n<20;n++)await Promise.resolve();expect(output).toHaveBeenCalledTimes(1);expect(JSON.stringify(output.mock.calls)).not.toContain("synthetic-private");controller.abort();await work;}finally{jest.useRealTimers();output.mockRestore();}
});
