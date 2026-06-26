import type { AppUser } from "./app-user";

declare module "fastify" {
  interface FastifyRequest {
    user?: AppUser;
  }
}
