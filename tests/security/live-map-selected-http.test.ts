jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async()=>undefined}));
jest.mock("../../src/modules/live-map-core/application/liveMapService",()=>({getLiveMapSnapshot:jest.fn()}));
import Fastify from "fastify";
import routes from "../../src/modules/live-map-core/transport/fastify-routes";
import {getLiveMapSnapshot} from "../../src/modules/live-map-core/application/liveMapService";
const user:any={id:"same-user",tenantId:"tenant-a",companyId:"company-a",companyMembershipId:"cm-a",membershipId:"cm-a",tenantMembershipId:"tm-a"};
beforeEach(()=>jest.clearAllMocks());
async function appFor(authenticated=true){const app=Fastify();app.addHook("onRequest",async request=>{if(authenticated)request.user=user;});await app.register(routes);return app;}
it("forwards the complete selected identity and never serves a cached snapshot",async()=>{
  const app=await appFor();try{(getLiveMapSnapshot as jest.Mock).mockResolvedValue({orders:[],drivers:[],warehouses:[],isPartial:true});
    for(let i=0;i<2;i++){const response=await app.inject({method:"GET",url:"/snapshot"});expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");}
    expect(getLiveMapSnapshot).toHaveBeenCalledTimes(2);expect(getLiveMapSnapshot).toHaveBeenCalledWith({actor:user,viewport:null});
  }finally{await app.close();}
});
it.each([403,500])("sanitizes snapshot error %s",async statusCode=>{
  const app=await appFor();const log=jest.spyOn(console,"error").mockImplementation(()=>undefined);try{(getLiveMapSnapshot as jest.Mock).mockRejectedValue(Object.assign(new Error("PRIVATE-CANARY"),{statusCode}));const response=await app.inject({method:"GET",url:"/snapshot"});expect(response.statusCode).toBe(statusCode);expect(response.body).not.toContain("PRIVATE-CANARY");expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE-CANARY");}finally{log.mockRestore();await app.close();}
});
it("missing authentication and partial viewport deny before building a snapshot",async()=>{
  const anonymous=await appFor(false);const selected=await appFor();try{expect((await anonymous.inject({method:"GET",url:"/snapshot"})).statusCode).toBe(401);expect((await selected.inject({method:"GET",url:"/snapshot?minLat=50"})).statusCode).toBe(400);expect(getLiveMapSnapshot).not.toHaveBeenCalled();}finally{await anonymous.close();await selected.close();}
});
it("legacy SSE is unavailable before streaming headers or snapshot work",async()=>{
  const app=await appFor();try{const response=await app.inject({method:"GET",url:"/stream",headers:{"last-event-id":"foreign-event"}});expect(response.statusCode).toBe(409);expect(response.headers["content-type"]).not.toContain("text/event-stream");expect(getLiveMapSnapshot).not.toHaveBeenCalled();}finally{await app.close();}
});
