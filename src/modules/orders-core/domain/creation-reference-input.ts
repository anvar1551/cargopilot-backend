import { authorityError } from "./creation-authority";
export type References = { customerEntityId?: string | null; senderAddressId?: string | null; receiverAddressId?: string | null };
export function normalizeCreationReferences(input: References): References {
  const result: References = {};
  for (const key of ["customerEntityId", "senderAddressId", "receiverAddressId"] as const) {
    const value = input[key];
    if (value == null || value === "") result[key] = null;
    else if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw authorityError("Valid master reference UUID required");
    else result[key] = value.toLowerCase();
  }
  if ((result.senderAddressId || result.receiverAddressId) && !result.customerEntityId) throw authorityError("Address references require an explicit customer", 403);
  return result;
}

/** Reject supported IDs in unsupported DTO positions instead of letting Zod discard them. */
export function assertCreationDtoReferencePlacement(raw: unknown) {
  const pending: Array<{value: unknown; path: string}> = [{value: raw, path: ""}];
  while(pending.length) {
    const {value,path}=pending.pop()!; if(!value || typeof value!=="object")continue;
    for(const [key,child] of Object.entries(value)) {
      const next=path ? path+"."+key : key;
      if (["customerEntityId","senderAddressId","receiverAddressId"].includes(key) && child!=null && child!=="" &&
          !["customerEntityId","addresses.senderAddressId","addresses.receiverAddressId"].includes(next)) throw authorityError("Unsupported master reference position");
      pending.push({value:child,path:next});
    }
  }
}
