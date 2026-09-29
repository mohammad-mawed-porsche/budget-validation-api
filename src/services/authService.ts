import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { verify as verifyPassword } from "argon2";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

import type { AuthPrincipal, AuthSession, AuthTokens, AuthUser } from "../domain/auth.js";
import type { AuthRepository } from "../repositories/authRepository.js";

const roleSchema = z.enum(["admin", "operator", "viewer"]);
const usersSchema = z.array(z.object({
  username: z.string().trim().min(1).max(256),
  passwordHash: z.string().startsWith("$argon2id$"),
  roles: z.array(roleSchema).min(1),
  disabled: z.boolean().default(false),
}).strict()).min(1);

export interface LoginContext { ipAddress: string; userAgent: string | null }
export interface SessionAuthConfig {
  sessionSecret: string;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
  idleTtlSeconds: number;
  absoluteTtlSeconds: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
  usersJson: string;
}
export interface AuthService { authenticate(authorization: string | undefined): Promise<AuthPrincipal | null> }
export interface InteractiveAuthService extends AuthService {
  login(username: string, password: string, context: LoginContext): Promise<AuthTokens>;
  refresh(refreshToken: string, context: LoginContext): Promise<AuthTokens>;
  logout(refreshToken: string | null, authorization: string | undefined): Promise<void>;
}
export class InvalidCredentialsError extends Error {}
export class LoginRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("Too many login attempts."); }
}
export class InvalidSessionError extends Error {}

const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$DyqVy4S0P8qtzbgk8aratQ$lnXh+/tm3ZOcQT+v17YuRf/Zc1nUyNJiedOre9kgrxk";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
function equalSecret(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
function refreshSessionId(token: string): string | null {
  if (token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2 && parts.length !== 3) return null;
  return /^[a-f0-9-]{36}$/i.test(parts[0] ?? "") && /^[A-Za-z0-9_-]{43}$/.test(parts[1] ?? "") ? parts[0]! : null;
}

export class StaticBearerAuthService implements AuthService {
  constructor(private readonly token: string) {}
  async authenticate(authorization: string | undefined): Promise<AuthPrincipal | null> {
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length).trim();
    if (!token || !equalSecret(token, this.token)) return null;
    return { subject: "local-api-token", username: "local-api-token", sessionId: "static", roles: ["admin", "operator", "viewer"] };
  }
}

export class SessionAuthService implements InteractiveAuthService {
  private readonly users: Map<string, AuthUser>;
  private readonly key: Uint8Array;

  constructor(
    private readonly repository: AuthRepository,
    private readonly config: SessionAuthConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly uuid: () => string = randomUUID,
  ) {
    const parsed = usersSchema.parse(JSON.parse(config.usersJson));
    this.users = new Map(parsed.map((user) => [user.username.toLowerCase(), user]));
    if (this.users.size !== parsed.length) throw new Error("AUTH_USERS_JSON contains duplicate usernames.");
    this.key = new TextEncoder().encode(config.sessionSecret);
  }

  private attemptKey(username: string, ipAddress: string) {
    return hash(`${username.trim().toLowerCase()}\n${ipAddress}`);
  }

  private refreshSignature(value: string) {
    return createHmac("sha256", this.key).update(`budget-refresh.v1.${value}`).digest("base64url");
  }

  private createRefreshToken(sessionId: string) {
    const value = `${sessionId}.${randomBytes(32).toString("base64url")}`;
    return `${value}.${this.refreshSignature(value)}`;
  }

  private signedRefreshToken(token: string) {
    const parts = token.split(".");
    return parts.length === 3 && equalSecret(parts[2]!, this.refreshSignature(`${parts[0]}.${parts[1]}`));
  }

  private sessionUserAllowed(session: AuthSession) {
    const user = this.users.get(session.username.toLowerCase());
    return Boolean(user && !user.disabled && [...user.roles].sort().join(",") === [...session.roles].sort().join(","));
  }

  private async signAccessToken(session: AuthSession) {
    const now = this.now();
    const expiresAt = new Date(Math.min(now.getTime() + this.config.accessTtlSeconds * 1_000, Date.parse(session.absoluteExpiresAt)));
    const token = await new SignJWT({ roles: session.roles, username: session.username, sid: session.id })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(session.username)
      .setJti(this.uuid())
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt(Math.floor(now.getTime() / 1_000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(this.key);
    return { token, expiresAt: expiresAt.toISOString() };
  }

  private tokens(session: AuthSession, refresh: string, access: { token: string; expiresAt: string }): AuthTokens {
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh,
      refreshTokenExpiresAt: session.idleExpiresAt,
      tokenType: "Bearer",
      principal: { subject: session.username, username: session.username, sessionId: session.id, roles: [...session.roles] },
    };
  }

  async login(username: string, password: string, context: LoginContext): Promise<AuthTokens> {
    const normalized = username.trim().toLowerCase();
    const attemptKey = this.attemptKey(normalized, context.ipAddress);
    const limit = await this.repository.consumeLoginAttempt(attemptKey, this.config.loginMaxAttempts, this.config.loginWindowSeconds, this.now());
    if (!limit.allowed) throw new LoginRateLimitError(limit.retryAfterSeconds);

    const user = this.users.get(normalized);
    let passwordValid = false;
    if (user && !user.disabled && Buffer.byteLength(password, "utf8") <= 1_024) {
      try { passwordValid = await verifyPassword(user.passwordHash, password); } catch { passwordValid = false; }
    } else {
      try { await verifyPassword(DUMMY_PASSWORD_HASH, password); } catch { /* Keep the generic credential failure. */ }
    }
    if (!user || user.disabled || !passwordValid) throw new InvalidCredentialsError("Invalid username or password.");
    await this.repository.clearLoginAttempts(attemptKey);

    const now = this.now();
    const id = this.uuid();
    const refresh = this.createRefreshToken(id);
    const session: AuthSession = {
      id,
      username: user.username,
      roles: [...user.roles],
      refreshTokenHash: hash(refresh),
      createdAt: now.toISOString(),
      idleExpiresAt: new Date(now.getTime() + this.config.idleTtlSeconds * 1_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + this.config.absoluteTtlSeconds * 1_000).toISOString(),
      lastSeenAt: now.toISOString(),
      revokedAt: null,
      userAgentHash: context.userAgent ? hash(context.userAgent) : null,
      ipHash: hash(context.ipAddress),
    };
    await this.repository.createSession(session);
    return this.tokens(session, refresh, await this.signAccessToken(session));
  }

  async authenticate(authorization: string | undefined): Promise<AuthPrincipal | null> {
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length).trim();
    if (!token || token.length > 8_192) return null;
    try {
      const result = await jwtVerify(token, this.key, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["HS256"],
        clockTolerance: 30,
        currentDate: this.now(),
      });
      const sessionId = typeof result.payload.sid === "string" ? result.payload.sid : null;
      const username = typeof result.payload.username === "string" ? result.payload.username : null;
      const tokenRoles = Array.isArray(result.payload.roles)
        ? result.payload.roles.filter((role): role is AuthPrincipal["roles"][number] => roleSchema.safeParse(role).success)
        : [];
      if (!sessionId || !username || tokenRoles.length === 0) return null;
      const session = await this.repository.getSession(sessionId);
      const now = this.now().getTime();
      if (!session || session.revokedAt || session.username !== username || Date.parse(session.absoluteExpiresAt) <= now || Date.parse(session.idleExpiresAt) <= now) return null;
      if (!this.sessionUserAllowed(session)) return null;
      if (session.roles.join(",") !== tokenRoles.join(",")) return null;
      return { subject: username, username, sessionId, roles: [...session.roles] };
    } catch { return null; }
  }

  async refresh(token: string, context: LoginContext): Promise<AuthTokens> {
    const sessionId = refreshSessionId(token);
    if (!sessionId) throw new InvalidSessionError("Refresh session is invalid.");
    const session = await this.repository.getSession(sessionId);
    const now = this.now();
    // A known session ID is not proof of token possession. A signed old token
    // can trigger replay revocation; arbitrary garbage must never revoke it.
    // Accept the current legacy two-part token once to migrate existing sessions.
    const currentLegacyToken = token.split(".").length === 2 && session && equalSecret(hash(token), session.refreshTokenHash);
    if (!session || (!this.signedRefreshToken(token) && !currentLegacyToken)) {
      throw new InvalidSessionError("Refresh session is invalid or expired.");
    }
    if (session.revokedAt || !equalSecret(hash(token), session.refreshTokenHash)
      || !this.sessionUserAllowed(session)
      || Date.parse(session.absoluteExpiresAt) <= now.getTime() || Date.parse(session.idleExpiresAt) <= now.getTime()
      || (session.userAgentHash && session.userAgentHash !== hash(context.userAgent ?? ""))) {
      await this.repository.revokeSession(session.id, now.toISOString());
      throw new InvalidSessionError("Refresh session is invalid or expired.");
    }

    const rotated = this.createRefreshToken(session.id);
    const updated: AuthSession = {
      ...session,
      refreshTokenHash: hash(rotated),
      lastSeenAt: now.toISOString(),
      idleExpiresAt: new Date(Math.min(now.getTime() + this.config.idleTtlSeconds * 1_000, Date.parse(session.absoluteExpiresAt))).toISOString(),
      ipHash: hash(context.ipAddress),
    };
    if (!await this.repository.rotateSession(session.id, session.refreshTokenHash, updated)) {
      await this.repository.revokeSession(session.id, now.toISOString());
      throw new InvalidSessionError("Refresh token reuse was detected.");
    }
    return this.tokens(updated, rotated, await this.signAccessToken(updated));
  }

  async logout(token: string | null, authorization: string | undefined): Promise<void> {
    const refreshId = token ? refreshSessionId(token) : null;
    if (refreshId && token) {
      const session = await this.repository.getSession(refreshId);
      if (session && equalSecret(hash(token), session.refreshTokenHash)) {
        return this.repository.revokeSession(refreshId, this.now().toISOString());
      }
    }
    const principal = await this.authenticate(authorization);
    if (principal) await this.repository.revokeSession(principal.sessionId, this.now().toISOString());
  }
}
