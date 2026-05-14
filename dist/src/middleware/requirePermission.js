"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirePermission = requirePermission;
const identity_access_1 = require("../modules/identity-access");
function requirePermission(permission) {
    return async (req, res, next) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: "Unauthorized" });
            }
            await (0, identity_access_1.authorize)(req.user, permission);
            return next();
        }
        catch (err) {
            const code = err?.statusCode ?? 403;
            return res.status(code).json({ error: err?.message ?? "Forbidden" });
        }
    };
}
