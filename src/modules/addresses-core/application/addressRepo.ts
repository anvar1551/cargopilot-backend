import { AddressType, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import {
  CustomerAccessContext,
  customerAccessError,
  rejectOwnershipFields,
  requireCustomerAccess,
} from "../../customers-core/application/customerAccess";

export type AddressWriteDto = {
  customerEntityId: string;
  country?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  street?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  building?: string | null;
  apartment?: string | null;
  floor?: string | null;
  landmark?: string | null;
  postalCode?: string | null;
  addressType?: AddressType | null;
  isSaved?: boolean;
};

export type AddressUpdateDto = Omit<Partial<AddressWriteDto>, "customerEntityId">;

function addressData(dto: AddressUpdateDto) {
  return {
    ...(dto.country !== undefined ? { country: dto.country } : {}),
    ...(dto.city !== undefined ? { city: dto.city } : {}),
    ...(dto.neighborhood !== undefined ? { neighborhood: dto.neighborhood } : {}),
    ...(dto.street !== undefined ? { street: dto.street } : {}),
    ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
    ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
    ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
    ...(dto.addressLine2 !== undefined ? { addressLine2: dto.addressLine2 } : {}),
    ...(dto.building !== undefined ? { building: dto.building } : {}),
    ...(dto.apartment !== undefined ? { apartment: dto.apartment } : {}),
    ...(dto.floor !== undefined ? { floor: dto.floor } : {}),
    ...(dto.landmark !== undefined ? { landmark: dto.landmark } : {}),
    ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
    ...(dto.addressType !== undefined ? { addressType: dto.addressType } : {}),
    ...(dto.isSaved !== undefined ? { isSaved: dto.isSaved } : {}),
  };
}

async function requireOwnedCustomer(
  access: Awaited<ReturnType<typeof requireCustomerAccess>>,
  customerEntityId: string,
) {
  const customer = await prisma.customerEntity.findFirst({
    where: { AND: [{ id: customerEntityId }, access.customerWhere] },
    select: { id: true },
  });
  if (!customer) throw customerAccessError("Customer not found", 404);
  return customer;
}

export async function listAddresses(context: CustomerAccessContext, params: {
  customerEntityId?: string;
  q?: string;
  take?: number;
}) {
  const access = await requireCustomerAccess(context, "customers.read");
  const take = Math.min(Math.max(Math.floor(params.take ?? 20), 1), 50);
  const q = params.q?.trim();
  if (params.customerEntityId) await requireOwnedCustomer(access, params.customerEntityId);
  return prisma.address.findMany({
    where: {
      tenantId: access.snapshot.tenantId,
      customerEntity: access.customerWhere,
      ...(params.customerEntityId ? { customerEntityId: params.customerEntityId } : {}),
      ...(q ? { OR: [
        { city: { contains: q, mode: "insensitive" } },
        { street: { contains: q, mode: "insensitive" } },
        { addressLine1: { contains: q, mode: "insensitive" } },
        { neighborhood: { contains: q, mode: "insensitive" } },
        { postalCode: { contains: q, mode: "insensitive" } },
        { landmark: { contains: q, mode: "insensitive" } },
      ] } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take,
  });
}

async function findAddressById(
  access: Awaited<ReturnType<typeof requireCustomerAccess>>,
  id: string,
) {
  return prisma.address.findFirst({
    where: {
      id,
      tenantId: access.snapshot.tenantId,
      customerEntity: access.customerWhere,
    },
  });
}

export async function getAddressById(context: CustomerAccessContext, id: string) {
  const access = await requireCustomerAccess(context, "customers.read");
  return findAddressById(access, id);
}

export async function createAddress(context: CustomerAccessContext, dto: AddressWriteDto) {
  const access = await requireCustomerAccess(context, "customers.write");
  rejectOwnershipFields(dto, ["tenantId", "tenant", "companyId", "companyMembershipId", "id",
    "customerEntity", "tenantCustomerEntity"]);
  const customerEntityId = String(dto.customerEntityId ?? "").trim();
  if (!customerEntityId) throw customerAccessError("customerEntityId is required", 400);
  await requireOwnedCustomer(access, customerEntityId);
  return prisma.address.create({
    data: {
      tenantId: access.snapshot.tenantId,
      customerEntityId,
      ...addressData(dto),
    } as Prisma.AddressUncheckedCreateInput,
  });
}

export async function updateAddress(context: CustomerAccessContext, id: string, dto: AddressUpdateDto) {
  const access = await requireCustomerAccess(context, "customers.write");
  rejectOwnershipFields(dto, ["tenantId", "tenant", "companyId", "companyMembershipId", "id",
    "customerEntityId", "customerEntity", "tenantCustomerEntity"]);
  const where: Prisma.AddressWhereInput = {
    id,
    tenantId: access.snapshot.tenantId,
    customerEntity: access.customerWhere,
  };
  const current = await prisma.address.findFirst({ where, select: { id: true } });
  if (!current) return null;
  const result = await prisma.address.updateMany({ where, data: addressData(dto) });
  if (result.count !== 1) return null;
  return findAddressById(access, id);
}

export async function deleteAddress(context: CustomerAccessContext, id: string) {
  const access = await requireCustomerAccess(context, "customers.write");
  const where: Prisma.AddressWhereInput = {
    id,
    tenantId: access.snapshot.tenantId,
    customerEntity: access.customerWhere,
  };
  const current = await prisma.address.findFirst({ where, select: { id: true } });
  if (!current) return false;
  const result = await prisma.address.deleteMany({ where });
  return result.count === 1;
}
