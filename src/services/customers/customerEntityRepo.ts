import prisma from "../../config/prismaClient";
import { Prisma, CustomerType } from "@prisma/client";

export type ListCustomerParams = {
  q?: string;
  type?: CustomerType;
  page?: number;
  limit?: number;
};

export async function listCustomerEntities(params?: ListCustomerParams) {
  const q = params?.q?.trim();
  const type = params?.type;
  const page = params?.page ?? 1;
  const limit = Math.min(params?.limit ?? 20, 100);
  const skip = (page - 1) * limit;

  const where: Prisma.CustomerEntityWhereInput = {};

  if (type) {
    where.type = type;
  }

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { companyName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q, mode: "insensitive" } },
      { taxId: { contains: q, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await prisma.$transaction([
    prisma.customerEntity.findMany({
      where,
      include: {
        defaultAddress: true,
        _count: {
          select: {
            orders: true,
            users: true,
            addresses: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.customerEntity.count({ where }),
  ]);

  return {
    data: rows,
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

export async function createCustomerEntity(dto: CreateCustomerDto) {
  return prisma.customerEntity.create({
    data: {
      type: dto.type,
      name: dto.name,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      altPhone1: dto.altPhone1 ?? null,
      altPhone2: dto.altPhone2 ?? null,
      companyName: dto.companyName ?? null,
      taxId: dto.taxId ?? null,
    },
    include: {
      defaultAddress: true,
      _count: {
        select: {
          orders: true,
          users: true,
          addresses: true,
        },
      },
    },
  });
}

export async function getCustomerEntityById(id: string) {
  return prisma.customerEntity.findUnique({
    where: { id },
    include: {
      defaultAddress: true,
      addresses: {
        where: { isSaved: true },
        orderBy: { createdAt: "desc" },
        take: 8,
      },
      _count: {
        select: {
          orders: true,
          users: true,
          addresses: true,
        },
      },
    },
  });
}
