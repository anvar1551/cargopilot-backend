import type { Prisma, PrismaClient } from "@prisma/client";
import type { AppUser } from "../../../types/app-user";
import { requireCustomerAccess } from "../../customers-core/application/customerAccess";
import { requireTenantBoundOrderCompanyAuthority } from "./company-authority";
import { authorityError } from "./creation-authority";

import { normalizeCreationReferences, type References } from "./creation-reference-input";
/** No lookup/write for free-text workflows. Master access never derives from a user-global link. */
export async function validateCreationReferences(db: Prisma.TransactionClient | PrismaClient, actor: AppUser, input: References, lockRecords: boolean) {
  const refs = normalizeCreationReferences(input);
  if (!refs.customerEntityId) return refs;
  await requireTenantBoundOrderCompanyAuthority(db, actor, "customers.read");
  const access = await requireCustomerAccess(actor, "customers.read");
  // Actual write/retry transactions retain referenced records while using their ownership.
  if (lockRecords) {
    await db.$queryRaw`SELECT id FROM "CustomerEntity" WHERE id=${refs.customerEntityId}::uuid AND "tenantId"=${actor.tenantId}::uuid FOR SHARE`;
  }
  const customer = await db.customerEntity.findFirst({ where: { AND: [access.customerWhere, { id: refs.customerEntityId, tenantId: actor.tenantId! }] }, select: { id: true } });
  if (!customer) throw authorityError("Customer reference not accessible", 403);
  for (const key of ["senderAddressId", "receiverAddressId"] as const) {
    const id = refs[key]; if (!id) continue;
    if (lockRecords) await db.$queryRaw`SELECT id FROM "Address" WHERE id=${id}::uuid AND "tenantId"=${actor.tenantId}::uuid FOR SHARE`;
    const address = await db.address.findFirst({ where: { id, tenantId: actor.tenantId!, customerEntityId: customer.id }, select: { id: true } });
    if (!address) throw authorityError("Address does not belong to the accessible customer", 403);
  }
  return refs;
}
