import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { sendApiError } from "../http.js";
import {
  InvalidCredentialsError,
  InvalidSessionError,
  LoginRateLimitError,
  type InteractiveAuthService,
} from "../services/authService.js";

const credentialsSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1_024),
}).strict();

export interface AuthCookieConfig {
  name: string;
  secure: boolean;
  domain?: string;
}

function requestContext(request: FastifyRequest) {
  const userAgent = request.headers["user-agent"];
  return { ipAddress: request.ip, userAgent: typeof userAgent === "string" ? userAgent : null };
}

function refreshCookieOptions(cookie: AuthCookieConfig, expiresAt?: string) {
  return {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: "strict" as const,
    path: "/v1/auth",
    ...(expiresAt ? { expires: new Date(expiresAt) } : {}),
    ...(cookie.domain ? { domain: cookie.domain } : {}),
  };
}

function setRefreshCookie(reply: FastifyReply, cookie: AuthCookieConfig, token: string, expiresAt: string) {
  reply.setCookie(cookie.name, token, refreshCookieOptions(cookie, expiresAt));
}

function clearRefreshCookie(reply: FastifyReply, cookie: AuthCookieConfig) {
  reply.clearCookie(cookie.name, refreshCookieOptions(cookie));
}

export function registerAuthRoutes(app: FastifyInstance, auth: InteractiveAuthService, cookie: AuthCookieConfig) {
  app.post("/v1/auth/login", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return sendApiError(reply, 400, request.id, "INVALID_REQUEST", "Username and password are required.");
    try {
      const tokens = await auth.login(parsed.data.username, parsed.data.password, requestContext(request));
      request.log.info({ username: tokens.principal.username, sessionId: tokens.principal.sessionId, roles: tokens.principal.roles }, "Authentication login succeeded");
      setRefreshCookie(reply, cookie, tokens.refreshToken, tokens.refreshTokenExpiresAt);
      return reply.send({
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        tokenType: tokens.tokenType,
        user: tokens.principal,
      });
    } catch (error) {
      if (error instanceof LoginRateLimitError) {
        request.log.warn({ clientIp: request.ip }, "Authentication login rate limited");
        reply.header("Retry-After", String(error.retryAfterSeconds));
        return sendApiError(reply, 429, request.id, "LOGIN_RATE_LIMITED", "Too many attempts. Try again later.");
      }
      if (error instanceof InvalidCredentialsError) {
        request.log.warn({ clientIp: request.ip }, "Authentication login rejected");
        return sendApiError(reply, 401, request.id, "INVALID_CREDENTIALS", error.message);
      }
      throw error;
    }
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const token = request.cookies[cookie.name];
    if (!token) return sendApiError(reply, 401, request.id, "INVALID_SESSION", "Refresh session is missing.");
    try {
      const tokens = await auth.refresh(token, requestContext(request));
      request.log.info({ username: tokens.principal.username, sessionId: tokens.principal.sessionId }, "Authentication session refreshed");
      setRefreshCookie(reply, cookie, tokens.refreshToken, tokens.refreshTokenExpiresAt);
      return reply.send({
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        tokenType: tokens.tokenType,
        user: tokens.principal,
      });
    } catch (error) {
      if (error instanceof InvalidSessionError) {
        request.log.warn({ clientIp: request.ip }, "Authentication refresh rejected");
        clearRefreshCookie(reply, cookie);
        return sendApiError(reply, 401, request.id, "INVALID_SESSION", error.message);
      }
      throw error;
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    await auth.logout(request.cookies[cookie.name] ?? null, request.headers.authorization);
    request.log.info({ username: request.authPrincipal?.username ?? null }, "Authentication session logged out");
    clearRefreshCookie(reply, cookie);
    return reply.code(204).send();
  });

  app.get("/v1/auth/me", async (request, reply) => reply.send({ user: request.authPrincipal }));
}
