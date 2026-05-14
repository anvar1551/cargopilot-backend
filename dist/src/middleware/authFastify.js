"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fastifyAuth = fastifyAuth;
const identity_access_1 = require("../modules/identity-access");
const auth_1 = require("./auth");
function fastifyAuth(options = {}) {
    return async (request, reply) => {
        const user = await (0, auth_1.resolveAuthenticatedUserFromAuthHeader)(typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined);
        if (!user) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.user = user;
        if (options.permission) {
            try {
                await (0, identity_access_1.authorize)(user, options.permission);
            }
            catch (err) {
                return reply
                    .code(err?.statusCode ?? 403)
                    .send({ error: err?.message ?? "Forbidden" });
            }
        }
    };
}
