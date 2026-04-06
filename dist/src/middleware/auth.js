"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = auth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
function getBearerToken(req) {
    const header = req.headers.authorization;
    if (!header)
        return null;
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token)
        return null;
    return token;
}
function auth(requiredRoles = []) {
    return async (req, res, next) => {
        const token = getBearerToken(req);
        if (!token)
            return res.status(401).json({ error: "Invalid or missing token" });
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            // fail fast (especially important in prod)
            return res.status(500).json({ error: "JWT_SECRET not configured" });
        }
        try {
            const decoded = jsonwebtoken_1.default.verify(token, secret);
            const user = await prismaClient_1.default.user.findUnique({
                where: { id: decoded.id },
                select: {
                    id: true,
                    role: true,
                    customerEntityId: true,
                    email: true,
                    name: true,
                    warehouseId: true,
                },
            });
            if (!user)
                return res.status(401).json({ error: "Unauthorized" });
            req.user = user;
            if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
                return res.status(403).json({ error: "Forbidden" });
            }
            next();
        }
        catch (e) {
            return res.status(401).json({ error: "Unauthorized" });
        }
    };
}
