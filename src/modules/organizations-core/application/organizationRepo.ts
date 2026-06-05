import { OrganizationType, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";

export type ListOrganizationsParams = {
  where?: Prisma.OrganizationWhereInput;
  type?: OrganizationType;
  parentOrgId?: string | null;
  isActive?: boolean;
  q?: string;
  page?: number;
  limit?: number;
};

function normalizePagination(page?: number, limit?: number) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit ?? 20)));
  const safePage = Math.max(1, Number(page ?? 1));
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

export function isAllowedParentType(args: {
  childType: OrganizationType;
  parentType: OrganizationType | null;
}) {
  const { childType, parentType } = args;
  if (childType === OrganizationType.company) return parentType === null;
  if (childType === OrganizationType.branch) return parentType === OrganizationType.company;
  if (childType === OrganizationType.agent) {
    return parentType === OrganizationType.company || parentType === OrganizationType.branch;
  }
  if (childType === OrganizationType.pickup_point) {
    return (
      parentType === OrganizationType.company ||
      parentType === OrganizationType.branch ||
      parentType === OrganizationType.agent
    );
  }
  if (childType === OrganizationType.carrier) return parentType === OrganizationType.company;
  if (childType === OrganizationType.client) {
    return (
      parentType === OrganizationType.company ||
      parentType === OrganizationType.branch ||
      parentType === OrganizationType.agent ||
      parentType === OrganizationType.pickup_point
    );
  }
  return false;
}

export async function getOrganizationById(args: {
  id: string;
  where?: Prisma.OrganizationWhereInput | null;
}) {
  return prisma.organization.findFirst({
    where: {
      id: args.id,
      ...(args.where ?? {}),
    },
    include: {
      parentOrg: {
        select: { id: true, name: true, type: true, code: true, isActive: true },
      },
      _count: {
        select: {
          childOrgs: true,
          companyMemberships: true,
          ownedOrders: true,
          assignedOrders: true,
        },
      },
    },
  });
}

export async function listOrganizations(params?: ListOrganizationsParams) {
  const pagination = normalizePagination(params?.page, params?.limit);
  const where: Prisma.OrganizationWhereInput = {
    ...(params?.where ?? {}),
  };

  if (params?.type) where.type = params.type;
  if (params?.parentOrgId != null) where.parentOrgId = params.parentOrgId;
  if (typeof params?.isActive === "boolean") where.isActive = params.isActive;

  const q = String(params?.q || "").trim();
  if (q) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { code: { contains: q, mode: "insensitive" } },
        ],
      },
    ];
  }

  const [items, total] = await prisma.$transaction([
    prisma.organization.findMany({
      where,
      orderBy: [{ type: "asc" }, { name: "asc" }],
      skip: pagination.skip,
      take: pagination.limit,
      include: {
        parentOrg: {
          select: { id: true, name: true, type: true, code: true, isActive: true },
        },
        _count: {
          select: {
            childOrgs: true,
            companyMemberships: true,
            ownedOrders: true,
            assignedOrders: true,
          },
        },
      },
    }),
    prisma.organization.count({ where }),
  ]);

  return {
    data: items,
    total,
    page: pagination.page,
    limit: pagination.limit,
    pageCount: Math.max(1, Math.ceil(total / pagination.limit)),
  };
}

export async function createOrganization(args: {
  name: string;
  type: OrganizationType;
  code?: string | null;
  parentOrgId?: string | null;
  isActive?: boolean;
}) {
  return prisma.organization.create({
    data: {
      name: args.name,
      type: args.type,
      code: args.code ?? null,
      parentOrgId: args.parentOrgId ?? null,
      isActive: args.isActive ?? true,
    },
  });
}

export async function updateOrganization(args: {
  id: string;
  name?: string;
  type?: OrganizationType;
  code?: string | null;
  parentOrgId?: string | null;
  isActive?: boolean;
}) {
  const data: Prisma.OrganizationUpdateInput = {};
  if (typeof args.name === "string") data.name = args.name;
  if (args.type) data.type = args.type;
  if (args.code !== undefined) data.code = args.code;
  if (args.parentOrgId !== undefined) {
    data.parentOrg =
      args.parentOrgId === null
        ? { disconnect: true }
        : { connect: { id: args.parentOrgId } };
  }
  if (typeof args.isActive === "boolean") data.isActive = args.isActive;

  return prisma.organization.update({
    where: { id: args.id },
    data,
  });
}

export async function deactivateOrganization(id: string) {
  return prisma.organization.update({
    where: { id },
    data: { isActive: false },
  });
}
