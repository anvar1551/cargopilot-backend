"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAllowedParentType = isAllowedParentType;
exports.getOrganizationById = getOrganizationById;
exports.listOrganizations = listOrganizations;
exports.createOrganization = createOrganization;
exports.updateOrganization = updateOrganization;
exports.deactivateOrganization = deactivateOrganization;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
function normalizePagination(page, limit) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit ?? 20)));
    const safePage = Math.max(1, Number(page ?? 1));
    return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}
function isAllowedParentType(args) {
    const { childType, parentType } = args;
    if (childType === client_1.OrganizationType.company)
        return parentType === null;
    if (childType === client_1.OrganizationType.branch)
        return parentType === client_1.OrganizationType.company;
    if (childType === client_1.OrganizationType.agent) {
        return parentType === client_1.OrganizationType.company || parentType === client_1.OrganizationType.branch;
    }
    if (childType === client_1.OrganizationType.pickup_point) {
        return (parentType === client_1.OrganizationType.company ||
            parentType === client_1.OrganizationType.branch ||
            parentType === client_1.OrganizationType.agent);
    }
    if (childType === client_1.OrganizationType.carrier)
        return parentType === client_1.OrganizationType.company;
    if (childType === client_1.OrganizationType.client) {
        return (parentType === client_1.OrganizationType.company ||
            parentType === client_1.OrganizationType.branch ||
            parentType === client_1.OrganizationType.agent ||
            parentType === client_1.OrganizationType.pickup_point);
    }
    return false;
}
async function getOrganizationById(args) {
    return prismaClient_1.default.organization.findFirst({
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
async function listOrganizations(params) {
    const pagination = normalizePagination(params?.page, params?.limit);
    const where = {
        ...(params?.where ?? {}),
    };
    if (params?.type)
        where.type = params.type;
    if (params?.parentOrgId != null)
        where.parentOrgId = params.parentOrgId;
    if (typeof params?.isActive === "boolean")
        where.isActive = params.isActive;
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
    const [items, total] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.organization.findMany({
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
        prismaClient_1.default.organization.count({ where }),
    ]);
    return {
        data: items,
        total,
        page: pagination.page,
        limit: pagination.limit,
        pageCount: Math.max(1, Math.ceil(total / pagination.limit)),
    };
}
async function createOrganization(args) {
    return prismaClient_1.default.organization.create({
        data: {
            name: args.name,
            type: args.type,
            code: args.code ?? null,
            parentOrgId: args.parentOrgId ?? null,
            isActive: args.isActive ?? true,
        },
    });
}
async function updateOrganization(args) {
    const data = {};
    if (typeof args.name === "string")
        data.name = args.name;
    if (args.type)
        data.type = args.type;
    if (args.code !== undefined)
        data.code = args.code;
    if (args.parentOrgId !== undefined) {
        data.parentOrg =
            args.parentOrgId === null
                ? { disconnect: true }
                : { connect: { id: args.parentOrgId } };
    }
    if (typeof args.isActive === "boolean")
        data.isActive = args.isActive;
    return prismaClient_1.default.organization.update({
        where: { id: args.id },
        data,
    });
}
async function deactivateOrganization(id) {
    return prismaClient_1.default.organization.update({
        where: { id },
        data: { isActive: false },
    });
}
