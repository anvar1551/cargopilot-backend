import { CustomerType, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import {
  CustomerAccessContext,
  customerAccessError,
  rejectOwnershipFields,
  requireCustomerAccess,
} from "./customerAccess";

export type ListCustomerParams = {
  q?: string;
  type?: CustomerType;
  page?: number;
  limit?: number;
};

function customerInclude(tenantId: string) {
  return {
    defaultAddress: true,
    _count: { select: {
      orders: { where: { tenantId } },
      users: { where: { memberships: { some: { tenantId } } } },
      addresses: { where: { tenantId } },
    } },
  } satisfies Prisma.CustomerEntityInclude;
}

function hideInconsistentDefaultAddress<T extends {
  id: string;
  tenantId: string | null;
  defaultAddress?: { tenantId: string | null; customerEntityId: string | null } | null;
}>(customer: T): T {
  if (!customer.defaultAddress) return customer;
  if (customer.defaultAddress.tenantId === customer.tenantId
    && customer.defaultAddress.customerEntityId === customer.id) return customer;
  return { ...customer, defaultAddress: null };
}

export async function listCustomerEntities(context: CustomerAccessContext, params: ListCustomerParams = {}) {
  const access = await requireCustomerAccess(context, "customers.read");
  const q = params.q?.trim();
  const page = Math.max(Math.floor(params.page ?? 1), 1);
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 20), 1), 100);
  const filters: Prisma.CustomerEntityWhereInput[] = [access.customerWhere];
  if (params.type) filters.push({ type: params.type });
  if (q) {
    filters.push({ OR: [
      { name: { contains: q, mode: "insensitive" } },
      { companyName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q, mode: "insensitive" } },
      { taxId: { contains: q, mode: "insensitive" } },
    ] });
  }
  const where: Prisma.CustomerEntityWhereInput = { AND: filters };
  const [rows, total] = await prisma.$transaction([
    prisma.customerEntity.findMany({
      where,
      include: customerInclude(access.snapshot.tenantId),
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.customerEntity.count({ where }),
  ]);
  return {
    data: rows.map(hideInconsistentDefaultAddress),
    total,
    page,
    limit,
    pageCount: Math.ceil(total / limit),
  };
}

export type CreateCustomerDto = {
  type: CustomerType;
  name: string;
  email?: string | null;
  phone?: string | null;
  altPhone1?: string | null;
  altPhone2?: string | null;
  companyName?: string | null;
  taxId?: string | null;
};

export type UpdateCustomerDto = Partial<CreateCustomerDto> & { defaultAddressId?: string | null };

function customerData(dto: Partial<CreateCustomerDto>) {
  return {
    ...(dto.type !== undefined ? { type: dto.type } : {}),
    ...(dto.name !== undefined ? { name: dto.name } : {}),
    ...(dto.email !== undefined ? { email: dto.email } : {}),
    ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
    ...(dto.altPhone1 !== undefined ? { altPhone1: dto.altPhone1 } : {}),
    ...(dto.altPhone2 !== undefined ? { altPhone2: dto.altPhone2 } : {}),
    ...(dto.companyName !== undefined ? { companyName: dto.companyName } : {}),
    ...(dto.taxId !== undefined ? { taxId: dto.taxId } : {}),
  };
}

export async function createCustomerEntity(context: CustomerAccessContext, dto: CreateCustomerDto) {
  const access = await requireCustomerAccess(context, "customers.write");
  rejectOwnershipFields(dto, ["tenantId", "tenant", "companyId", "companyMembershipId", "id",
    "defaultAddressId", "defaultAddress", "tenantDefaultAddress", "addresses", "tenantAddresses"]);
  if (!access.hasTenantWideCustomerScope) throw customerAccessError("Forbidden");
  const created = await prisma.customerEntity.create({
    data: { tenantId: access.snapshot.tenantId, ...customerData(dto) } as Prisma.CustomerEntityUncheckedCreateInput,
    include: customerInclude(access.snapshot.tenantId),
  });
  return hideInconsistentDefaultAddress(created);
}

async function findCustomerEntityById(
  access: Awaited<ReturnType<typeof requireCustomerAccess>>,
  id: string,
) {
  const customer = await prisma.customerEntity.findFirst({
    where: { AND: [{ id }, access.customerWhere] },
    include: {
      ...customerInclude(access.snapshot.tenantId),
      addresses: {
        where: { tenantId: access.snapshot.tenantId, customerEntityId: id, isSaved: true },
        orderBy: { createdAt: "desc" },
        take: 8,
      },
    },
  });
  return customer ? hideInconsistentDefaultAddress(customer) : null;
}

export async function getCustomerEntityById(context: CustomerAccessContext, id: string) {
  const access = await requireCustomerAccess(context, "customers.read");
  return findCustomerEntityById(access, id);
}

export async function updateCustomerEntity(context: CustomerAccessContext, id: string, dto: UpdateCustomerDto) {
  const access = await requireCustomerAccess(context, "customers.write");
  rejectOwnershipFields(dto, ["tenantId", "tenant", "companyId", "companyMembershipId", "id",
    "defaultAddress", "tenantDefaultAddress", "addresses", "tenantAddresses"]);
  if (dto.defaultAddressId) {
    const address = await prisma.address.findFirst({
      where: {
        id: dto.defaultAddressId,
        tenantId: access.snapshot.tenantId,
        customerEntityId: id,
        customerEntity: access.customerWhere,
      },
      select: { id: true },
    });
    if (!address) throw customerAccessError("Default address does not belong to this customer", 400);
  }
  const where: Prisma.CustomerEntityWhereInput = { AND: [{ id }, access.customerWhere] };
  const current = await prisma.customerEntity.findFirst({ where, select: { id: true } });
  if (!current) return null;
  const result = await prisma.customerEntity.updateMany({
    where,
    data: {
      ...customerData(dto),
      ...(dto.defaultAddressId !== undefined ? { defaultAddressId: dto.defaultAddressId } : {}),
    },
  });
  if (result.count !== 1) return null;
  return findCustomerEntityById(access, id);
}

export async function deleteCustomerEntity(context: CustomerAccessContext, id: string) {
  const access = await requireCustomerAccess(context, "customers.write");
  const where: Prisma.CustomerEntityWhereInput = { AND: [{ id }, access.customerWhere] };
  const current = await prisma.customerEntity.findFirst({ where, select: { id: true } });
  if (!current) return false;
  const result = await prisma.customerEntity.deleteMany({ where });
  return result.count === 1;
}
