import type { FastifyInstance } from "fastify";

import type { AuthRole } from "../domain/auth.js";
import { sendApiError } from "../http.js";
import type { AuthService } from "../services/authService.js";

const PUBLIC_AUTH_PATHS = new Set(["/v1/auth/login", "/v1/auth/refresh", "/v1/auth/logout"]);

function requiredRole(method: string, url: string): AuthRole {
  if (method === "PUT" && url.startsWith("/v1/schedule")) return "admin";
  if (method === "POST" && url.startsWith("/v1/runs")) return "operator";
  if (method === "POST" && url.startsWith("/v1/notifications/test")) return "operator";
  return "viewer";
}

function hasRole(roles: AuthRole[], required: AuthRole): boolean {
  if (roles.includes("admin")) return true;
  if (required === "viewer" && roles.includes("operator")) return true;
  return roles.includes(required);
}

export function registerAuthentication(app: FastifyInstance, auth: AuthService) {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (PUBLIC_AUTH_PATHS.has(pathname)) return;
    const principal = await auth.authenticate(request.headers.authorization);
    if (principal) {
      request.authPrincipal = principal;
      const role = requiredRole(request.method, pathname);
      if (hasRole(principal.roles, role)) return;
      return sendApiError(reply, 403, request.id, "FORBIDDEN", `${role} permission is required.`);
    }
    reply.header("WWW-Authenticate", 'Bearer realm="budget-validation-api"');
    return sendApiError(reply, 401, request.id, "UNAUTHORIZED", "A valid bearer token is required.");
  });
}
