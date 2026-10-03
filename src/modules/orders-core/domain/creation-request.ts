import { createHash } from "crypto";
import type { CreateOrderRepoPayload } from "./orderCreate.mapper";
import type { OrderActor } from "../shared";
import { authorityError } from "./creation-authority";

const fields = ["pickupAddress","dropoffAddress","destinationCity","pickupLat","pickupLng","dropoffLat","dropoffLng",
  "savePickupToAddressBook","saveDropoffToAddressBook","senderAddressSnapshot","receiverAddressSnapshot",
  "senderName","senderPhone","senderPhone2","senderPhone3","receiverName","receiverPhone","receiverPhone2","receiverPhone3",
  "senderAddress","receiverAddress","customerEntityId","senderAddressId","receiverAddressId","serviceType","transportMode",
  "weightKg","codAmount","currency","paymentType","paymentProvider","paymentIntentIdempotencyKey","deliveryChargePaidBy",
  "ifRecipientNotAvailable","itemValue","plannedPickupAt","plannedDeliveryAt","promiseDate","referenceId","shelfId","promoCode",
  "numberOfCalls","fragile","dangerousGoods","shipmentInsurance","pieceTotal","parcels"] as const;
const snapshotFields = ["country","city","neighborhood","street","latitude","longitude","addressLine1","addressLine2",
  "building","apartment","floor","landmark","postalCode","addressType"];
const issued = new WeakSet<object>();
const rowBindings = new WeakMap<object,string[]>();
export type CreationRequest = Readonly<{
  tenantId: string; companyId: string; userId: string; tenantMembershipId: string; companyMembershipId: string;
  operationId: string; kind: "order" | "import"; fingerprint: string; normalizationVersion: 1; rowCount: number;
}>;
export function creationOperationId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    throw authorityError("A durable UUID operationId is required");
  return value.toLowerCase();
}
function canonical(value: unknown, depth=0): string {
  if(depth>12) throw authorityError("Creation intent depth limit exceeded");
  if (value == null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "string") {
    if (Buffer.byteLength(value)>2048) throw authorityError("Creation intent text limit exceeded");
    return JSON.stringify(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw authorityError("Invalid creation number");
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if(value.length>100) throw authorityError("Creation intent array limit exceeded");
    return `[${value.map(item=>canonical(item,depth+1)).join(",")}]`;
  }
  if (typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k],depth+1)}`).join(",")}}`;
  throw authorityError("Unsupported creation intent value");
}
function normalizeRow(row: CreateOrderRepoPayload) {
  return Object.fromEntries(fields.map(key => {
    let value: unknown = row[key] ?? null;
    if (key==="senderAddressSnapshot" || key==="receiverAddressSnapshot") value = value == null ? null : Object.fromEntries(snapshotFields.map(k=>[k,(value as any)[k]??null]));
    if (["plannedPickupAt","plannedDeliveryAt","promiseDate"].includes(key) && value!=null) {
      const date = new Date(value as string | Date);
      if(Number.isNaN(date.getTime())) throw authorityError("Invalid creation date");
      value=date.toISOString();
    }
    return [key,value];
  }));
}
export function buildCreationRequest(actor: OrderActor, operationId: unknown, kind: "order" | "import", rows: CreateOrderRepoPayload[]): CreationRequest {
  if (!actor.id || !actor.tenantId || !actor.companyId || !actor.tenantMembershipId || !actor.companyMembershipId || actor.membershipId!==actor.companyMembershipId)
    throw authorityError("Tenant-bound creation context required",403);
  if (!rows.length || rows.length>100 || (kind==="order" && rows.length!==1)) throw authorityError("Invalid creation row count");
  const normalized = rows.map(normalizeRow);
  const encoded = canonical({ version:1, kind, rows: normalized });
  if (Buffer.byteLength(encoded)>1024*1024) throw authorityError("Creation intent byte limit exceeded");
  const request: CreationRequest=Object.freeze({userId:actor.id,tenantId:actor.tenantId,companyId:actor.companyId,
    tenantMembershipId:actor.tenantMembershipId,companyMembershipId:actor.companyMembershipId,
    operationId:creationOperationId(operationId),kind,fingerprint:createHash("sha256").update(encoded).digest("hex"),normalizationVersion:1,rowCount:rows.length});
  issued.add(request);
  rowBindings.set(request, normalized.map(row=>createHash("sha256").update(canonical({...row,currency:null})).digest("hex")));
  return request;
}
/** Provenance guard for internal callers; fresh database authorization is still mandatory. */
export function assertCreationRequest(actor: OrderActor, request: CreationRequest, ordinal: number) {
  if (!request || !issued.has(request) || !Number.isInteger(ordinal) || ordinal<0 || ordinal>=request.rowCount ||
      request.userId!==actor.id || request.tenantId!==actor.tenantId || request.companyId!==actor.companyId ||
      request.companyMembershipId!==actor.companyMembershipId || request.tenantMembershipId!==actor.tenantMembershipId)
    throw authorityError("Creation request/context conflict",409);
}


/** Prepared pricing may replace quoted currency; all other normalized intent fields remain fixed. */
export function assertCreationPayload(actor: OrderActor, request: CreationRequest, ordinal: number, payload: CreateOrderRepoPayload) {
  assertCreationRequest(actor,request,ordinal);
  const fingerprint=createHash("sha256").update(canonical({...normalizeRow(payload),currency:null})).digest("hex");
  if(rowBindings.get(request)?.[ordinal]!==fingerprint) throw authorityError("Prepared creation content conflicts with intent",409);
}
