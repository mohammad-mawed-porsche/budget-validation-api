import type { AuthSession } from "../domain/auth.js";

export interface LoginAttemptResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthRepository {
  initialize(): Promise<void>;
  createSession(session: AuthSession): Promise<void>;
  getSession(sessionId: string): Promise<AuthSession | null>;
  rotateSession(sessionId: string, expectedRefreshHash: string, session: AuthSession): Promise<boolean>;
  revokeSession(sessionId: string, revokedAt: string): Promise<void>;
  consumeLoginAttempt(key: string, maxAttempts: number, windowSeconds: number, now: Date): Promise<LoginAttemptResult>;
  clearLoginAttempts(key: string): Promise<void>;
}
