jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async()=>{}}));
jest.mock("../../src/modules/customers-core/application/customerEntityRepo",()=>({
 createCustomerEntity:jest.fn(async(_actor,input)=>({id:"synthetic",...input})),
 updateCustomerEntity:jest.fn(async(_actor,_id,input)=>({id:"synthetic",...input})),
 listCustomerEntities:jest.fn(),getCustomerEntityById:jest.fn(),deleteCustomerEntity:jest.fn(),
}));
import Fastify from "fastify";
import routes from "../../src/modules/customers-core/transport/fastify-routes";
import {createCustomerEntity,updateCustomerEntity} from "../../src/modules/customers-core/application/customerEntityRepo";

describe("customer HTTP schema composition with installed Zod",()=>{
 const app=Fastify();
 beforeAll(async()=>{await app.register(routes,{prefix:"/api/customers"});await app.ready();});
 afterAll(async()=>{await app.close();});
 beforeEach(()=>jest.clearAllMocks());
 it("registers and accepts valid individual and company creation",async()=>{
  for(const body of [{type:"PERSON",name:"Synthetic"},{type:"COMPANY",name:"Synthetic",companyName:"Synthetic company",taxId:"TEST-only"}]){
   const result=await app.inject({method:"POST",url:"/api/customers",payload:body});expect(result.statusCode).toBe(201);
  }
  expect(createCustomerEntity).toHaveBeenCalledTimes(2);
 });
 it("rejects missing company fields and unknown ownership without repository writes",async()=>{
  for(const body of [{type:"COMPANY",name:"Synthetic"},{type:"PERSON",name:"Synthetic",tenantId:"foreign"}]){
   const result=await app.inject({method:"POST",url:"/api/customers",payload:body});expect(result.statusCode).toBe(400);
  }
  expect(createCustomerEntity).not.toHaveBeenCalled();
 });
 it("accepts legitimate partial/default-address updates",async()=>{
  for(const body of [{phone:"synthetic"},{defaultAddressId:"00000000-0000-4000-8000-000000000001"},{defaultAddressId:null}]){
   const result=await app.inject({method:"PATCH",url:"/api/customers/synthetic",payload:body});expect(result.statusCode).toBe(200);
  }
  expect(updateCustomerEntity).toHaveBeenCalledTimes(3);
 });
 it("retains company refinement and ownership field rejection on updates",async()=>{
  for(const body of [{type:"COMPANY"},{tenantId:"foreign"}]){
   const result=await app.inject({method:"PATCH",url:"/api/customers/synthetic",payload:body});expect(result.statusCode).toBe(400);
  }
  expect(updateCustomerEntity).not.toHaveBeenCalled();
 });
});
