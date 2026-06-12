"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUser = registerUser;
exports.loginUser = loginUser;
exports.refreshUserSession = refreshUserSession;
exports.revokeRefreshSession = revokeRefreshSession;
exports.changeUserPassword = changeUserPassword;
exports.listUsersForCompany = listUsersForCompany;
exports.updateUserAccessByCompanyAdmin = updateUserAccessByCompanyAdmin;
exports.createUserByCompanyAdmin = createUserByCompanyAdmin;
exports.deleteUserMembershipFromCompany = deleteUserMembershipFromCompany;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const access_control_1 = require("../access-control");
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret)
        throw new Error("JWT_SECRET not configured");
    return secret;
}
function getRefreshTokenSecret() {
    return process.env.REFRESH_TOKEN_SECRET || getJwtSecret();
}
function getAccessTokenTtl() {
    return process.env.ACCESS_TOKEN_TTL || "12h";
}
function getRefreshTokenTtl() {
    return process.env.REFRESH_TOKEN_TTL || "30d";
}
function hashToken(token) {
    return (0, crypto_1.createHash)("sha256").update(token).digest("hex");
}
function getTokenExpiryDate(token) {
    const decoded = jsonwebtoken_1.default.decode(token);
    if (!decoded?.exp)
        throw new Error("Unable to read token expiry");
    return new Date(decoded.exp * 1000);
}
function getTokenLifetimeSec(token) {
    const decoded = jsonwebtoken_1.default.decode(token);
    if (!decoded?.exp || !decoded?.iat)
        return 0;
    const ttl = decoded.exp - decoded.iat;
    return ttl > 0 ? ttl : 0;
}
function signAccessToken(payload) {
    return jsonwebtoken_1.default.sign({
        ...payload,
        tokenType: "access",
    }, getJwtSecret(), { expiresIn: getAccessTokenTtl() });
}
function signRefreshToken(payload) {
    return jsonwebtoken_1.default.sign(payload, getRefreshTokenSecret(), {
        expiresIn: getRefreshTokenTtl(),
    });
}
function cleanRoleCodes(input) {
    if (!Array.isArray(input))
        return [];
    return Array.from(new Set(input
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)));
}
function cleanScopeInput(input) {
    if (!Array.isArray(input))
        return [];
    const normalized = input
        .map((item) => {
        if (!item || typeof item !== "object")
            return null;
        const scopeType = String(item.scopeType || "").trim().toLowerCase();
        const scopeRefId = String(item.scopeRefId || "").trim();
        if (!scopeType || !scopeRefId)
            return null;
        if (scopeType !== "company" &&
            scopeType !== "branch" &&
            scopeType !== "warehouse" &&
            scopeType !== "agent" &&
            scopeType !== "pickup_point" &&
            scopeType !== "carrier" &&
            scopeType !== "client") {
            return null;
        }
        return {
            scopeType: scopeType,
            scopeRefId,
        };
    })
        .filter((value) => Boolean(value));
    const dedupe = new Map();
    for (const item of normalized) {
        dedupe.set(`${item.scopeType}:${item.scopeRefId}`, item);
    }
    return Array.from(dedupe.values());
}
async function resolveRoleIdsForCompany(args) {
    if (args.roleCodes.length === 0)
        return [];
    const roles = await args.tx.role.findMany({
        where: {
            code: { in: args.roleCodes },
            OR: [{ companyId: null }, { companyId: args.companyId }],
        },
        select: { id: true, code: true },
    });
    const roleMap = new Map(roles.map((item) => [item.code, item.id]));
    const resolved = [];
    for (const code of args.roleCodes) {
        const id = roleMap.get(code);
        if (!id)
            throw new Error(`Role '${code}' was not found for this company`);
        resolved.push(id);
    }
    return resolved;
}
async function createRefreshSession(args) {
    const sessionId = (0, crypto_1.randomUUID)();
    const refreshToken = signRefreshToken({
        id: args.userId,
        sid: sessionId,
        tokenType: "refresh",
    });
    await prismaClient_1.default.userRefreshSession.create({
        data: {
            id: sessionId,
            userId: args.userId,
            tokenHash: hashToken(refreshToken),
            expiresAt: getTokenExpiryDate(refreshToken),
            userAgent: args.userAgent ?? null,
            ipAddress: args.ipAddress ?? null,
        },
    });
    return refreshToken;
}
async function issueAuthSession(args) {
    const token = signAccessToken({
        id: args.userId,
        membershipId: args.membershipId,
        companyId: args.companyId,
        branchId: args.branchId ?? null,
    });
    const refreshToken = await createRefreshSession({
        userId: args.userId,
        userAgent: args.userAgent ?? null,
        ipAddress: args.ipAddress ?? null,
    });
    return {
        token,
        refreshToken,
        accessTokenExpiresInSec: getTokenLifetimeSec(token),
    };
}
async function resolveDefaultCompanyForRegistration() {
    const companyCode = String(process.env.ERP_PUBLIC_REGISTRATION_COMPANY_CODE || "")
        .trim()
        .toUpperCase();
    if (companyCode) {
        const byCode = await prismaClient_1.default.organization.findFirst({
            where: { code: companyCode, type: client_1.OrganizationType.company, isActive: true },
            select: { id: true },
        });
        if (byCode)
            return byCode.id;
    }
    const firstCompany = await prismaClient_1.default.organization.findFirst({
        where: { type: client_1.OrganizationType.company, isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
    });
    if (!firstCompany) {
        throw new Error("No active company found for registration");
    }
    return firstCompany.id;
}
async function registerUser(args) {
    const name = String(args.name || "").trim();
    const email = String(args.email || "").trim().toLowerCase();
    const password = String(args.password || "");
    if (!name)
        throw new Error("Name is required");
    if (!email)
        throw new Error("Email is required");
    if (password.length < 6)
        throw new Error("Password must be at least 6 characters");
    const existing = await prismaClient_1.default.user.findUnique({ where: { email }, select: { id: true } });
    if (existing)
        throw new Error("Email already registered");
    const roleCodes = cleanRoleCodes(args.roleCodes).length > 0
        ? cleanRoleCodes(args.roleCodes)
        : [String(process.env.ERP_PUBLIC_REGISTRATION_ROLE_CODE || "").trim().toLowerCase()].filter(Boolean);
    if (roleCodes.length === 0) {
        throw new Error("Public registration role is not configured. Set ERP_PUBLIC_REGISTRATION_ROLE_CODE or pass roleCodes.");
    }
    const companyId = String(args.companyId || "").trim() || (await resolveDefaultCompanyForRegistration());
    const hashedPassword = await bcryptjs_1.default.hash(password, 10);
    const created = await prismaClient_1.default.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                customerEntity: {
                    create: {
                        type: "PERSON",
                        name: args.companyName?.trim() || name,
                        email,
                        phone: args.phone ?? null,
                    },
                },
            },
            select: { id: true, customerEntityId: true },
        });
        const membership = await tx.companyMembership.create({
            data: {
                userId: user.id,
                companyId,
                status: client_1.MembershipStatus.active,
            },
            select: { id: true, companyId: true, branchId: true },
        });
        const roleIds = await resolveRoleIdsForCompany({
            tx,
            companyId,
            roleCodes,
        });
        for (const roleId of roleIds) {
            await tx.membershipRole.create({
                data: { membershipId: membership.id, roleId },
            });
        }
        await tx.membershipScope.upsert({
            where: {
                membershipId_scopeType_scopeRefId: {
                    membershipId: membership.id,
                    scopeType: "company",
                    scopeRefId: companyId,
                },
            },
            create: {
                membershipId: membership.id,
                scopeType: "company",
                scopeRefId: companyId,
            },
            update: {},
        });
        return {
            userId: user.id,
            membershipId: membership.id,
            companyId: membership.companyId,
            branchId: membership.branchId,
        };
    });
    const session = await issueAuthSession({
        userId: created.userId,
        membershipId: created.membershipId,
        companyId: created.companyId,
        branchId: created.branchId ?? null,
        userAgent: args.userAgent ?? null,
        ipAddress: args.ipAddress ?? null,
    });
    (0, access_control_1.clearIdentityAccessCacheForUser)(created.userId);
    const access = await (0, access_control_1.loadAccessSnapshot)({
        userId: created.userId,
        membershipId: created.membershipId,
    });
    return { ...session, user: access };
}
async function loginUser(args) {
    const email = String(args.email || "").trim().toLowerCase();
    const password = String(args.password || "");
    if (!email || !password)
        throw new Error("Invalid email or password");
    const user = await prismaClient_1.default.user.findUnique({
        where: { email },
        select: { id: true, password: true },
    });
    if (!user)
        throw new Error("Invalid email or password");
    const ok = await bcryptjs_1.default.compare(password, user.password);
    if (!ok)
        throw new Error("Invalid email or password");
    const membership = await prismaClient_1.default.companyMembership.findFirst({
        where: { userId: user.id, status: client_1.MembershipStatus.active },
        orderBy: { createdAt: "asc" },
        select: { id: true, companyId: true, branchId: true },
    });
    if (!membership) {
        throw new Error("No active membership found");
    }
    const session = await issueAuthSession({
        userId: user.id,
        membershipId: membership.id,
        companyId: membership.companyId,
        branchId: membership.branchId ?? null,
        userAgent: args.userAgent ?? null,
        ipAddress: args.ipAddress ?? null,
    });
    (0, access_control_1.clearIdentityAccessCacheForUser)(user.id);
    const access = await (0, access_control_1.loadAccessSnapshot)({
        userId: user.id,
        membershipId: membership.id,
    });
    return { ...session, user: access };
}
async function refreshUserSession(args) {
    const rawToken = String(args.refreshToken || "").trim();
    if (!rawToken)
        throw new Error("Refresh token is required");
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(rawToken, getRefreshTokenSecret());
    }
    catch {
        throw new Error("Invalid refresh token");
    }
    if (!decoded?.id || !decoded?.sid || decoded.tokenType !== "refresh") {
        throw new Error("Invalid refresh token");
    }
    const session = await prismaClient_1.default.userRefreshSession.findUnique({
        where: { id: decoded.sid },
        include: {
            user: {
                select: { id: true },
            },
        },
    });
    if (!session || session.userId !== decoded.id)
        throw new Error("Invalid refresh token");
    if (session.revokedAt)
        throw new Error("Refresh token revoked");
    if (session.expiresAt <= new Date())
        throw new Error("Refresh token expired");
    if (session.tokenHash !== hashToken(rawToken))
        throw new Error("Refresh token mismatch");
    const membership = await prismaClient_1.default.companyMembership.findFirst({
        where: { userId: decoded.id, status: client_1.MembershipStatus.active },
        orderBy: { createdAt: "asc" },
        select: { id: true, companyId: true, branchId: true },
    });
    if (!membership)
        throw new Error("No active membership found");
    await prismaClient_1.default.userRefreshSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
    });
    const next = await issueAuthSession({
        userId: decoded.id,
        membershipId: membership.id,
        companyId: membership.companyId,
        branchId: membership.branchId ?? null,
        userAgent: args.userAgent ?? null,
        ipAddress: args.ipAddress ?? null,
    });
    (0, access_control_1.clearIdentityAccessCacheForUser)(decoded.id);
    const access = await (0, access_control_1.loadAccessSnapshot)({
        userId: decoded.id,
        membershipId: membership.id,
    });
    return { ...next, user: access };
}
async function revokeRefreshSession(refreshToken) {
    const token = String(refreshToken || "").trim();
    if (!token)
        return;
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(token, getRefreshTokenSecret());
    }
    catch {
        return;
    }
    if (!decoded?.sid)
        return;
    await prismaClient_1.default.userRefreshSession.updateMany({
        where: { id: decoded.sid, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}
async function changeUserPassword(args) {
    const user = await prismaClient_1.default.user.findUnique({
        where: { id: args.userId },
        select: { id: true, password: true },
    });
    if (!user)
        throw new Error("Unauthorized");
    const ok = await bcryptjs_1.default.compare(args.currentPassword, user.password);
    if (!ok)
        throw new Error("Current password is incorrect");
    const password = await bcryptjs_1.default.hash(args.newPassword, 10);
    await prismaClient_1.default.user.update({
        where: { id: args.userId },
        data: { password },
    });
    await prismaClient_1.default.userRefreshSession.updateMany({
        where: { userId: args.userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}
async function listUsersForCompany(args) {
    const page = Number.isFinite(args.page) ? Math.max(1, Math.floor(args.page)) : 1;
    const limit = Number.isFinite(args.limit)
        ? Math.min(100, Math.max(1, Math.floor(args.limit)))
        : 20;
    const whereSearch = String(args.q || "").trim();
    const where = {
        companyId: args.companyId,
        status: client_1.MembershipStatus.active,
        ...(whereSearch
            ? {
                user: {
                    OR: [
                        { name: { contains: whereSearch, mode: "insensitive" } },
                        { email: { contains: whereSearch, mode: "insensitive" } },
                    ],
                },
            }
            : null),
    };
    const [rows, total] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.companyMembership.findMany({
            where,
            skip: (page - 1) * limit,
            take: limit,
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                branchId: true,
                createdAt: true,
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        warehouseId: true,
                        customerEntityId: true,
                        driverType: true,
                    },
                },
                roles: {
                    select: {
                        role: {
                            select: {
                                id: true,
                                code: true,
                                name: true,
                                isSystem: true,
                            },
                        },
                    },
                },
                scopes: {
                    select: {
                        scopeType: true,
                        scopeRefId: true,
                    },
                },
            },
        }),
        prismaClient_1.default.companyMembership.count({ where }),
    ]);
    return {
        items: rows.map((membership) => ({
            id: membership.user.id,
            membershipId: membership.id,
            name: membership.user.name,
            email: membership.user.email,
            warehouseId: membership.user.warehouseId ?? null,
            customerEntityId: membership.user.customerEntityId ?? null,
            driverType: membership.user.driverType ?? null,
            branchId: membership.branchId ?? null,
            createdAt: membership.createdAt.toISOString(),
            roles: membership.roles.map((entry) => ({
                id: entry.role.id,
                code: entry.role.code,
                name: entry.role.name,
                isSystem: entry.role.isSystem,
            })),
            scopes: membership.scopes.map((scope) => ({
                scopeType: scope.scopeType,
                scopeRefId: scope.scopeRefId,
            })),
        })),
        total,
        page,
        limit,
    };
}
async function updateUserAccessByCompanyAdmin(args) {
    const userId = String(args.userId || "").trim();
    if (!userId)
        throw new Error("userId is required");
    const membership = await prismaClient_1.default.companyMembership.findFirst({
        where: {
            companyId: args.companyId,
            userId,
            status: client_1.MembershipStatus.active,
        },
        select: { id: true },
    });
    if (!membership)
        throw new Error("Membership not found");
    const nextName = args.name === undefined ? undefined : String(args.name || "").trim();
    const nextEmail = args.email === undefined
        ? undefined
        : String(args.email || "").trim().toLowerCase();
    if (nextName !== undefined && !nextName)
        throw new Error("Name is required");
    if (nextEmail !== undefined && !nextEmail)
        throw new Error("Email is required");
    const nextRoleCodes = args.roleCodes == null ? null : cleanRoleCodes(args.roleCodes);
    if (nextRoleCodes && nextRoleCodes.length === 0) {
        throw new Error("At least one role is required");
    }
    const nextScopes = args.scopes === undefined ? undefined : cleanScopeInput(args.scopes);
    await prismaClient_1.default.$transaction(async (tx) => {
        if (nextName !== undefined || nextEmail !== undefined || args.warehouseId !== undefined || args.customerEntityId !== undefined || args.driverType !== undefined) {
            await tx.user.update({
                where: { id: userId },
                data: {
                    ...(nextName !== undefined ? { name: nextName } : {}),
                    ...(nextEmail !== undefined ? { email: nextEmail } : {}),
                    ...(args.warehouseId !== undefined ? { warehouseId: args.warehouseId } : {}),
                    ...(args.customerEntityId !== undefined ? { customerEntityId: args.customerEntityId } : {}),
                    ...(args.driverType !== undefined ? { driverType: args.driverType } : {}),
                },
            });
        }
        if (args.branchId !== undefined) {
            await tx.companyMembership.update({
                where: { id: membership.id },
                data: { branchId: args.branchId },
            });
        }
        if (nextRoleCodes) {
            const roleIds = await resolveRoleIdsForCompany({
                tx,
                companyId: args.companyId,
                roleCodes: nextRoleCodes,
            });
            await tx.membershipRole.deleteMany({
                where: { membershipId: membership.id },
            });
            for (const roleId of roleIds) {
                await tx.membershipRole.create({
                    data: { membershipId: membership.id, roleId },
                });
            }
        }
        if (nextScopes !== undefined) {
            const scopeList = nextScopes.length > 0
                ? nextScopes
                : [
                    {
                        scopeType: "company",
                        scopeRefId: args.companyId,
                    },
                ];
            await tx.membershipScope.deleteMany({
                where: { membershipId: membership.id },
            });
            for (const scope of scopeList) {
                await tx.membershipScope.create({
                    data: {
                        membershipId: membership.id,
                        scopeType: scope.scopeType,
                        scopeRefId: scope.scopeRefId,
                    },
                });
            }
        }
    });
    (0, access_control_1.clearIdentityAccessCacheForUser)(userId);
    const access = await (0, access_control_1.loadAccessSnapshot)({
        userId,
        membershipId: membership.id,
    });
    return access;
}
async function createUserByCompanyAdmin(args) {
    const name = String(args.name || "").trim();
    const email = String(args.email || "").trim().toLowerCase();
    const password = String(args.password || "");
    if (!name)
        throw new Error("Name is required");
    if (!email)
        throw new Error("Email is required");
    if (password.length < 6)
        throw new Error("Password must be at least 6 characters");
    const existing = await prismaClient_1.default.user.findUnique({ where: { email }, select: { id: true } });
    if (existing)
        throw new Error("Email already registered");
    const roleCodes = cleanRoleCodes(args.roleCodes);
    if (roleCodes.length === 0)
        throw new Error("roleCodes is required");
    const scopes = cleanScopeInput(args.scopes);
    const hashedPassword = await bcryptjs_1.default.hash(password, 10);
    const created = await prismaClient_1.default.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                warehouseId: args.warehouseId ?? null,
                customerEntityId: args.customerEntityId ?? null,
                driverType: args.driverType ?? null,
            },
            select: { id: true },
        });
        const membership = await tx.companyMembership.create({
            data: {
                userId: user.id,
                companyId: args.companyId,
                branchId: args.branchId ?? null,
                status: client_1.MembershipStatus.active,
            },
            select: { id: true, companyId: true, branchId: true },
        });
        const roleIds = await resolveRoleIdsForCompany({
            tx,
            companyId: args.companyId,
            roleCodes,
        });
        for (const roleId of roleIds) {
            await tx.membershipRole.create({
                data: { membershipId: membership.id, roleId },
            });
        }
        const scopeList = scopes.length > 0
            ? scopes
            : [
                {
                    scopeType: "company",
                    scopeRefId: args.companyId,
                },
            ];
        for (const scope of scopeList) {
            await tx.membershipScope.create({
                data: {
                    membershipId: membership.id,
                    scopeType: scope.scopeType,
                    scopeRefId: scope.scopeRefId,
                },
            });
        }
        return {
            userId: user.id,
            membershipId: membership.id,
            companyId: membership.companyId,
            branchId: membership.branchId,
        };
    });
    (0, access_control_1.clearIdentityAccessCacheForUser)(created.userId);
    const access = await (0, access_control_1.loadAccessSnapshot)({
        userId: created.userId,
        membershipId: created.membershipId,
    });
    return access;
}
async function deleteUserMembershipFromCompany(args) {
    if (args.actorUserId === args.targetUserId) {
        throw new Error("You cannot delete yourself");
    }
    const membership = await prismaClient_1.default.companyMembership.findFirst({
        where: { userId: args.targetUserId, companyId: args.companyId },
        select: { id: true },
    });
    if (!membership)
        throw new Error("Membership not found");
    await prismaClient_1.default.$transaction(async (tx) => {
        await tx.membershipScope.deleteMany({
            where: { membershipId: membership.id },
        });
        await tx.membershipRole.deleteMany({
            where: { membershipId: membership.id },
        });
        await tx.companyMembership.delete({
            where: { id: membership.id },
        });
    });
    (0, access_control_1.clearIdentityAccessCacheForUser)(args.targetUserId);
}
