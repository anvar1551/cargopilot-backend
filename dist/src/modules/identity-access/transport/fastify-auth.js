"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fastifyAuth = fastifyAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const access_control_1 = require("../access-control");
function getBearerTokenFromHeader(header) {
    if (!header)
        return null;
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token)
        return null;
    return token;
}
async function resolveAuthenticatedUserFromAuthHeader(authorizationHeader) {
    const token = getBearerTokenFromHeader(authorizationHeader);
    if (!token)
        return null;
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        const e = new Error("JWT_SECRET not configured");
        e.statusCode = 500;
        throw e;
    }
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(token, secret);
    }
    catch {
        return null;
    }
    if (!decoded?.id || !decoded?.membershipId || decoded.tokenType !== "access") {
        return null;
    }
    const snapshot = await (0, access_control_1.loadAccessSnapshot)({
        userId: decoded.id,
        membershipId: decoded.membershipId,
    });
    if (!snapshot)
        return null;
    return {
        id: snapshot.userId,
        membershipId: snapshot.membershipId,
        companyId: snapshot.companyId,
        branchId: snapshot.branchId,
        email: snapshot.email,
        name: snapshot.name,
        warehouseId: snapshot.warehouseId,
        customerEntityId: snapshot.customerEntityId,
        roleCodes: snapshot.roleCodes,
        permissionCodes: snapshot.permissionCodes,
        scopes: snapshot.scopes,
    };
}
function fastifyAuth(options = {}) {
    return async (request, reply) => {
        const user = await resolveAuthenticatedUserFromAuthHeader(typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined);
        if (!user) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.user = user;
        if (options.permission) {
            try {
                await (0, access_control_1.authorize)(user, options.permission);
            }
            catch (err) {
                return reply
                    .code(err?.statusCode ?? 403)
                    .send({ error: err?.message ?? "Forbidden" });
            }
        }
        if (options.anyPermission?.length) {
            let lastError = null;
            for (const permission of options.anyPermission) {
                try {
                    await (0, access_control_1.authorize)(user, permission);
                    return;
                }
                catch (err) {
                    lastError = err;
                }
            }
            return reply
                .code(lastError?.statusCode ?? 403)
                .send({ error: lastError?.message ?? "Forbidden" });
        }
    };
}
