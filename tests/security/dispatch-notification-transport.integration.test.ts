jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_t, key) => { const value = (mockPrisma as any)[key]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,runId=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!runId||!/^[a-f0-9]{12}$/.test(runId))throw Error("Disposable identity required");
const target=new URL(url);
if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${runId}`)throw Error("Refusing existing target");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"});
let mockPrisma:PrismaClient;
const contexts:any[]=[
{id:ids.users.multiTenant,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.multiTransAsia,companyId:ids.organizations.transAsiaUz,companyMembershipId:ids.companyMemberships.multiTransAsiaUz},
{id:ids.users.multiTenant,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.multiTransAsia,companyId:ids.organizations.transAsiaDe,companyMembershipId:ids.companyMemberships.multiTransAsiaDe},
{id:ids.users.multiTenant,tenantId:ids.tenants.unrelated,tenantMembershipId:ids.tenantMemberships.multiUnrelated,companyId:ids.organizations.unrelated,companyMembershipId:ids.companyMemberships.multiUnrelated}].map(c=>({...c,membershipId:c.companyMembershipId}));
const a=contexts[0];
beforeAll(async()=>{
const marker=await pool.query('SELECT "runId" FROM "_CPDisposableRun"');if(marker.rows.length!==1||marker.rows[0].runId!==runId)throw Error("Storage ownership mismatch");
const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,createTenantDemoFixture());await client.query("COMMIT");}finally{client.release();}
mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});
for(const c of contexts){const role=await mockPrisma.role.create({data:{companyId:c.companyId,code:randomUUID(),name:"Synthetic verification"}});
for(const key of PERMISSIONS){const p=await mockPrisma.permission.upsert({where:{key},create:{key,resource:"synthetic",action:"test"},update:{}});await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:p.id}});}
await mockPrisma.membershipRole.create({data:{membershipId:c.membershipId,roleId:role.id}});
if(!await mockPrisma.membershipScope.findFirst({where:{membershipId:c.membershipId,scopeType:"company",scopeRefId:c.companyId}}))await mockPrisma.membershipScope.create({data:{membershipId:c.membershipId,scopeType:"company",scopeRefId:c.companyId}});
}
await setup();
},60000);
afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();});

import { fork, ChildProcess } from "child_process";
import path from "path";
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { persistDispatchNotification } from "../../src/modules/orders-core/domain/dispatch-notification";
import { listUserNotifications } from "../../src/modules/notifications-core/application/notificationService";
const WebSocket=require("ws"),secret="synthetic-disposable-notification-signing";
const PERMISSIONS=["drivers.telemetry"];
async function setup(){await mockPrisma.order.update({where:{id:ids.orders.transAsiaUz},data:{assignedDriverId:a.id,status:"assigned"}});}
async function token(c:any){const sid=randomUUID(),claims={...c,sid,tokenType:"access"};await mockPrisma.userRefreshSession.create({data:{id:sid,userId:c.id,tenantId:c.tenantId,tenantMembershipId:c.tenantMembershipId,companyMembershipId:c.companyMembershipId,tokenHash:createHash("sha256").update(sid).digest("hex"),expiresAt:new Date(Date.now()+3600000)}});return jwt.sign(claims,secret,{expiresIn:"1h"});}
async function notification(){return mockPrisma.$transaction(async tx=>{const tracking=await tx.tracking.create({data:{orderId:ids.orders.transAsiaUz,status:"assigned"}});return (await persistDispatchNotification(tx,tracking.id,"assignment"))!;});}
const notices=(wire:Wire)=>wire.events.filter(event=>event[0]==="driver:notification");
type Peer = { child: ChildProcess; port: number; emit: (notificationId: string) => Promise<void>; close: () => Promise<void> };
async function startSocketPeer(): Promise<Peer> {
  const env: NodeJS.ProcessEnv = { NODE_ENV:"test", JWT_SECRET:secret, CARGOPILOT_WORKER_TEST_DATABASE_URL:url, CARGOPILOT_WORKER_RUN_ID:runId };
  for(const key of ["PATH","SystemRoot","TEMP","TMP","USERPROFILE","APPDATA","LOCALAPPDATA"]) if(process.env[key]) env[key]=process.env[key];
  const child=fork(path.join(__dirname,"socket-session-process.ts"),[],{execArgv:["-r","ts-node/register/transpile-only"],env,stdio:["ignore","pipe","pipe","ipc"]});
  // Bounded diagnostic capture without printing credentials/query arguments.
  let diagnosticBytes=0; for(const stream of [child.stdout,child.stderr]) stream?.on("data",buffer=>{diagnosticBytes+=buffer.length; if(diagnosticBytes>65536) child.kill();});
  const waitMessage=(predicate:(m:any)=>boolean,ms:number)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error("Socket process deadline"));},ms);
    const onMessage=(m:any)=>{if(m?.kind==='startup-failed'||m?.kind==='failed'){cleanup();reject(Error("Socket process failed"));}else if(predicate(m)){cleanup();resolve(m);}};
    const onExit=()=>{cleanup();reject(Error("Socket process exited"));}; const cleanup=()=>{clearTimeout(timer);child.off("message",onMessage);child.off("exit",onExit);}; child.on("message",onMessage);child.on("exit",onExit);
  });
  const close=async()=>{ if(child.exitCode!==null) return; const ended=new Promise<void>(resolve=>child.once("exit",()=>resolve())); child.send({kind:"shutdown"}); const timer=setTimeout(()=>child.kill(),5000); try{await ended;}finally{clearTimeout(timer);} };
  try { const ready=await waitMessage(m=>m.kind==='ready',15000); return {child,port:ready.port,close,emit:async(notificationId:string)=>{const request=randomUUID(),done=waitMessage(m=>m.kind==='done'&&m.request===request,10000);child.send({kind:"emit-notification",request,notificationId});await done;}}; }
  catch(error){await close();throw error;}
}
type Wire = { ws: any; events: any[]; closed: Promise<void> };
async function connectWire(peer:Peer,token:string):Promise<Wire> {
  const ws=new WebSocket(`ws://127.0.0.1:${peer.port}/socket.io/?EIO=4&transport=websocket`),events:any[]=[];
  const closed=new Promise<void>(resolve=>ws.once("close",()=>resolve()));
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{ws.terminate();reject(Error("Socket connection deadline"));},7000);
    ws.on("error",()=>{clearTimeout(timer);reject(Error("Socket transport failure"));});
    ws.on("message",(buffer:any)=>{const packet=buffer.toString(); if(packet.startsWith('0'))ws.send('40'+JSON.stringify({token})); else if(packet==='2')ws.send('3'); else if(packet.startsWith('42')){const event=JSON.parse(packet.slice(2));events.push(event);if(event[0]==='driver:realtime:ready'){clearTimeout(timer);resolve();}} else if(packet.startsWith('44')){clearTimeout(timer);ws.terminate();reject(Error("Unauthorized socket"));}});
  }); return {ws,events,closed};
}
async function awaitClosed(wire:Wire,ms=7500){let timer:NodeJS.Timeout|undefined;try{await Promise.race([wire.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Revoked socket did not close")),ms);})]);}finally{if(timer)clearTimeout(timer);}}
async function withSocketPeers(work:(peers:Peer[],wires:Wire[])=>Promise<void>){const peers:Peer[]=[],wires:Wire[]=[];try{peers.push(await startSocketPeer());peers.push(await startSocketPeer());await work(peers,wires);}finally{for(const wire of wires)wire.ws.terminate();await Promise.all(peers.map(peer=>peer.close()));}}

it("real Socket.IO selected recipient only, repeated emission does not persist again, reconnect lists missed notification",async()=>withSocketPeers(async(peers,wires)=>{
const tokens=await Promise.all(contexts.map(token));for(const t of tokens)wires.push(await connectWire(peers[0],t));wires.push(await connectWire(peers[1],tokens[0]));
const id=await notification(),before=await mockPrisma.userNotification.findMany({orderBy:{id:"asc"}});
for(const peer of peers)await peer.emit(id);await new Promise(r=>setTimeout(r,150));
expect(notices(wires[0]).map(e=>e[1].id)).toEqual([id]);expect(notices(wires[3]).map(e=>e[1].id)).toEqual([id]);expect(notices(wires[1])).toEqual([]);expect(notices(wires[2])).toEqual([]);
await peers[0].emit(id);await new Promise(r=>setTimeout(r,100));expect(notices(wires[0]).map(e=>e[1].id)).toEqual([id,id]);expect(await mockPrisma.userNotification.findMany({orderBy:{id:"asc"}})).toEqual(before);
for(const wire of wires)wire.ws.terminate();await Promise.all(wires.map(w=>w.closed));
const missed=await notification();await peers[0].emit(missed);const rows=await mockPrisma.userNotification.findMany({orderBy:{id:"asc"}});
wires.push(await connectWire(peers[0],tokens[0]));expect(notices(wires[wires.length-1])).toEqual([]);
const list=await listUserNotifications(a);expect(list.items.map(row=>row.id)).toEqual(expect.arrayContaining([id,missed]));for(const c of contexts.slice(1))expect((await listUserNotifications(c)).items).toEqual([]);
expect(await mockPrisma.userNotification.findMany({orderBy:{id:"asc"}})).toEqual(rows);
}));
it.each(["membership","permission","session"])("real Socket.IO existing %s revocation prevents protected notification in both processes",async kind=>withSocketPeers(async(peers,wires)=>{
const t=await token(a);for(const peer of peers)wires.push(await connectWire(peer,t));const id=await notification(),before=await mockPrisma.userNotification.findMany({orderBy:{id:"asc"}});let restore:()=>Promise<any>;
if(kind==="membership"){await mockPrisma.companyMembership.update({where:{id:a.membershipId},data:{status:"suspended"}});restore=()=>mockPrisma.companyMembership.update({where:{id:a.membershipId},data:{status:"active"}});}
else if(kind==="permission"){const links=await mockPrisma.membershipRole.findMany({where:{membershipId:a.membershipId}});await mockPrisma.membershipRole.deleteMany({where:{membershipId:a.membershipId}});restore=()=>mockPrisma.membershipRole.createMany({data:links});}
else{const c:any=jwt.decode(t);await mockPrisma.userRefreshSession.update({where:{id:c.sid},data:{revokedAt:new Date()}});restore=async()=>{};}
try{for(const peer of peers)await peer.emit(id);await new Promise(r=>setTimeout(r,100));expect(wires.every(w=>notices(w).length===0)).toBe(true);if(kind!=="permission")await Promise.all(wires.map(w=>awaitClosed(w)));if(kind!=="permission")await expect(connectWire(peers[0],t)).rejects.toThrow("Unauthorized");expect(await mockPrisma.userNotification.findMany({orderBy:{id:"asc"}})).toEqual(before);}finally{await restore();}
}));
