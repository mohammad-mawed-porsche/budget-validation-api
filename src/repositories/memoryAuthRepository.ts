import type { AuthSession } from "../domain/auth.js";
import type { AuthRepository } from "./authRepository.js";

export class MemoryAuthRepository implements AuthRepository {
  sessions = new Map<string, AuthSession>();
  attempts = new Map<string, { count: number; startedAt: number }>();
  async initialize() {}
  async createSession(session: AuthSession) { this.sessions.set(session.id, structuredClone(session)); }
  async getSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }
  async rotateSession(sessionId: string, expectedRefreshHash: string, session: AuthSession) {
    const current = this.sessions.get(sessionId);
    if (!current || current.refreshTokenHash !== expectedRefreshHash || current.revokedAt) return false;
    this.sessions.set(sessionId, structuredClone(session));
    return true;
  }
  async revokeSession(sessionId: string, revokedAt: string) {
    const current = this.sessions.get(sessionId);
    if (current) this.sessions.set(sessionId, { ...current, revokedAt });
  }
  async consumeLoginAttempt(key: string, maxAttempts: number, windowSeconds: number, now: Date) {
    const current = this.attempts.get(key);
    const active = current && now.getTime() - current.startedAt < windowSeconds * 1_000;
    const attempt = active ? { ...current, count: current.count + 1 } : { count: 1, startedAt: now.getTime() };
    this.attempts.set(key, attempt);
    return {
      allowed: attempt.count <= maxAttempts,
      retryAfterSeconds: Math.max(1, Math.ceil((attempt.startedAt + windowSeconds * 1_000 - now.getTime()) / 1_000)),
    };
  }
  async clearLoginAttempts(key: string) { this.attempts.delete(key); }
}
