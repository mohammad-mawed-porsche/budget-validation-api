import type { AuthPrincipal } from "../domain/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    authPrincipal?: AuthPrincipal;
  }
}
