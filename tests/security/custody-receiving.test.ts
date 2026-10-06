jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
import { database as db } from "./fixtures";
import { observeOutgoingCustody } from "../../src/modules/orders-core/domain/custody-access";
const actor:any={id:"receiver",tenantId:"tenant",companyId:"company"};
const source:any={order:{id:"order"},latest:{id:"accepted-source",phase:"transport",driverUserId:"outgoing-driver",driverMembershipId:"outgoing-cm",actorUserId:"outgoing-driver",companyMembershipId:"outgoing-cm",tenantMembershipId:"outgoing-tm"}};
const member=(status="active",tmStatus="active")=>({status,driverEligibility:{enabled:true,driverType:"linehaul",userId:"outgoing-driver",tenantMembershipId:"outgoing-tm",tenantId:"tenant",companyId:"company"},tenantMembership:{id:"outgoing-tm",userId:"outgoing-driver",tenantId:"tenant",status:tmStatus}});
beforeEach(()=>{jest.clearAllMocks();db.companyMembership.findFirst.mockResolvedValue(member());});
function noEffects(){expect(db.companyMembership.update).not.toHaveBeenCalled();expect(db.order.update).not.toHaveBeenCalled();expect(db.orderCustodyAction.create).not.toHaveBeenCalled();}
it("observes an existing active outgoing bridge without requiring outgoing role permissions",async()=>{
  const result=await observeOutgoingCustody(db as any,actor,source);
  expect(result).toMatchObject({predecessorEventId:"accepted-source",userId:"outgoing-driver",suspended:false,reason:null});
  expect(db.companyMembership.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:"outgoing-cm",userId:"outgoing-driver",tenantId:"tenant",companyId:"company",tenantMembershipId:"outgoing-tm"}}));noEffects();
});
it("requires suspension reason and preserves exact original identities in observed audit evidence",async()=>{
  db.companyMembership.findFirst.mockResolvedValue(member("suspended"));
  await expect(observeOutgoingCustody(db as any,actor,source)).rejects.toThrow("reason required");
  expect(await observeOutgoingCustody(db as any,actor,source,"Synthetic receiving after suspension")).toMatchObject({companyMembershipId:"outgoing-cm",tenantMembershipId:"outgoing-tm",membershipStatus:"suspended",suspended:true,reason:"Synthetic receiving after suspension"});noEffects();
});
it("tenant-membership suspension also requires a reason without reactivating either membership",async()=>{
  db.companyMembership.findFirst.mockResolvedValue(member("active","suspended"));
  await expect(observeOutgoingCustody(db as any,actor,source)).rejects.toThrow("reason required");
  expect(await observeOutgoingCustody(db as any,actor,source,"Synthetic receiving observation")).toMatchObject({membershipStatus:"active",tenantMembershipStatus:"suspended",suspended:true});noEffects();
});
it("unaccepted or conflicting outgoing source never becomes authority",async()=>{
  for(const patch of [{phase:"transport-offered"},{driverMembershipId:null},{actorUserId:"someone-else"},{companyMembershipId:"foreign-cm"}]) await expect(observeOutgoingCustody(db as any,actor,{...source,latest:{...source.latest,...patch}},"Synthetic receiving observation")).rejects.toThrow();
  expect(db.companyMembership.findFirst).not.toHaveBeenCalled();noEffects();
});
it("missing, invited or inconsistent current outgoing bridges reject even with a reason",async()=>{
  for(const value of [null,member("invited"),{...member(),tenantMembership:{...member().tenantMembership,userId:"foreign-user"}},{...member(),tenantMembership:{...member().tenantMembership,tenantId:"foreign-tenant"}}]) {
    db.companyMembership.findFirst.mockResolvedValue(value);
    await expect(observeOutgoingCustody(db as any,actor,source,"Synthetic receiving observation")).rejects.toThrow("Consistent recorded");
  }noEffects();
});
