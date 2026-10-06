import { randomUUID } from "node:crypto";
jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:{}}));
import { warehouseCreationSchema } from "../../src/modules/warehouse-core/application/warehouseProvisioning";
const input=()=>({operationId:randomUUID(),name:"Synthetic warehouse",location:"Synthetic address"});
it("normalization preserves intentional warehouse fields and stable operation identity",()=>{
 const v=input(),a=warehouseCreationSchema.parse({...v,name:" "+v.name+" ",region:"  "});
 expect(a).toEqual({...v,type:"warehouse",region:null,latitude:null,longitude:null});
 expect(warehouseCreationSchema.parse({...a,latitude:90,longitude:-180,type:"pickup_point"})).toMatchObject({latitude:90,longitude:-180,type:"pickup_point"});
});
it.each([{tenantId:randomUUID()},{companyId:randomUUID()},{users:{connect:{id:randomUUID()}}},{latitude:91},{longitude:-181},{latitude:"10"},{type:"unknown"},{name:"a\nprivate"},{operationId:undefined},{location:"x".repeat(501)}])("invalid input rejects %j",extra=>{
 expect(warehouseCreationSchema.safeParse({...input(),...extra}).success).toBe(false);
});
