export type AuthRole = "admin" | "operator" | "viewer";

export interface AuthPrincipal {
  subject: string;
  username: string;
  sessionId: string;
  roles: AuthRole[];
}

export interface AuthUser {
  username: string;
  passwordHash: string;
  roles: AuthRole[];
  disabled: boolean;
}

export interface AuthSession {
  id: string;
  username: string;
  roles: AuthRole[];
  refreshTokenHash: string;
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  userAgentHash: string | null;
  ipHash: string | null;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: "Bearer";
  principal: AuthPrincipal;
}
