import {buildCreationRequest,assertCreationPayload,assertCreationRequest} from "../../src/modules/orders-core/domain/creation-request";
const actor:any={id:"user-a",tenantId:"tenant-a",companyId:"company-a",tenantMembershipId:"tm-a",companyMembershipId:"cm-a",membershipId:"cm-a"};
const operationId="50000000-0000-4000-8000-000000000001";
const row=()=>({pickupAddress:"Synthetic pickup",dropoffAddress:"Synthetic dropoff",currency:"UZS",parcels:[{weightKg:1}],senderAddressSnapshot:{city:"Bremen",country:"DE"}});
it("canonical object order, equivalent dates and UUID case preserve normalized identity",()=>{
  const first=buildCreationRequest(actor,operationId,"order",[{...row(),plannedPickupAt:"2026-10-03T12:00:00Z"}]);
  const retry=buildCreationRequest(actor,operationId.toUpperCase(),"order",[{...row(),senderAddressSnapshot:{country:"DE",city:"Bremen"},plannedPickupAt:"2026-10-03T12:00:00.000Z"}]);
  expect(retry.fingerprint).toBe(first.fingerprint);expect(retry.operationId).toBe(first.operationId);
});
it("changed normalized content, row ordering and operation kind conflict",()=>{
  const a=row(),b={...row(),pickupAddress:"Another pickup"};
  const header=buildCreationRequest(actor,operationId,"import",[a,b]);
  expect(buildCreationRequest(actor,operationId,"import",[b,a]).fingerprint).not.toBe(header.fingerprint);
  expect(buildCreationRequest(actor,operationId,"import",[a,{...b,parcels:[{weightKg:2}]}]).fingerprint).not.toBe(header.fingerprint);
  expect(buildCreationRequest(actor,operationId,"order",[a]).fingerprint).not.toBe(buildCreationRequest(actor,operationId,"import",[a]).fingerprint);
});
it("prepared pricing replacement retains intent but changed operational fields are rejected",()=>{
  const request=buildCreationRequest(actor,operationId,"order",[row()]);
  expect(()=>assertCreationPayload(actor,request,0,{...row(),serviceCharge:875.5,currency:"USD"})).not.toThrow();
  expect(()=>assertCreationPayload(actor,request,0,{...row(),dropoffAddress:"Changed"})).toThrow("conflicts with intent");
});
it("caller clones and foreign selected identity cannot pass internal provenance",()=>{
  const request=buildCreationRequest(actor,operationId,"order",[row()]);
  expect(()=>assertCreationRequest(actor,{...request},0)).toThrow();
  expect(()=>assertCreationRequest({...actor,companyMembershipId:"cm-b"},request,0)).toThrow();
  expect(()=>assertCreationRequest(actor,request,1)).toThrow();
});
it.each([undefined,"bad-uuid"])("missing/malformed operation ID %s is rejected",operation=>{
  expect(()=>buildCreationRequest(actor,operation,"order",[row()])).toThrow("operationId");
});
it("row, parcel, text and aggregate byte limits bound retained intent hashing",()=>{
  expect(()=>buildCreationRequest(actor,operationId,"import",Array.from({length:101},row))).toThrow("row count");
  expect(()=>buildCreationRequest(actor,operationId,"order",[{...row(),parcels:Array.from({length:101},()=>({weightKg:1}))}])).toThrow("array limit");
  expect(()=>buildCreationRequest(actor,operationId,"order",[{...row(),pickupAddress:"x".repeat(2049)}])).toThrow("text limit");
  const oversized=Array.from({length:100},()=>({...row(),pickupAddress:"x".repeat(2048),dropoffAddress:"x".repeat(2048),senderName:"x".repeat(2048),receiverName:"x".repeat(2048),senderPhone:"x".repeat(2048),receiverPhone:"x".repeat(2048)}));
  expect(()=>buildCreationRequest(actor,operationId,"import",oversized)).toThrow("byte limit");
});
