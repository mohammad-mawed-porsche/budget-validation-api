import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuthSession } from "../domain/auth.js";
import type { AuthRepository, LoginAttemptResult } from "./authRepository.js";

interface LoginAttempt { count: number; windowStartedAt: string }
interface AuthStore {
  version: 1;
  sessions: Record<string, AuthSession>;
  loginAttempts: Record<string, LoginAttempt>;
}
const emptyStore = (): AuthStore => ({ version: 1, sessions: {}, loginAttempts: {} });

export class FileAuthRepository implements AuthRepository {
  private data = emptyStore();
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AuthStore>;
      if (parsed.version !== 1 || !parsed.sessions || !parsed.loginAttempts) throw new Error("Invalid auth store format.");
      this.data = parsed as AuthStore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
    this.initialized = true;
  }

  private async persist() {
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    if (!this.initialized) throw new Error("Auth repository has not been initialized.");
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const result = operation();
      await this.persist();
      return result;
    } finally { release(); }
  }

  private async ready() {
    if (!this.initialized) throw new Error("Auth repository has not been initialized.");
    await this.queue;
  }

  async createSession(session: AuthSession) {
    await this.mutate(() => { this.data.sessions[session.id] = structuredClone(session); });
  }
  async getSession(sessionId: string) {
    await this.ready();
    const session = this.data.sessions[sessionId];
    return session ? structuredClone(session) : null;
  }
  async rotateSession(sessionId: string, expectedRefreshHash: string, session: AuthSession) {
    return this.mutate(() => {
      const current = this.data.sessions[sessionId];
      if (!current || current.refreshTokenHash !== expectedRefreshHash || current.revokedAt) return false;
      this.data.sessions[sessionId] = structuredClone(session);
      return true;
    });
  }
  async revokeSession(sessionId: string, revokedAt: string) {
    await this.mutate(() => {
      const current = this.data.sessions[sessionId];
      if (current) this.data.sessions[sessionId] = { ...current, revokedAt };
    });
  }
  async consumeLoginAttempt(key: string, maxAttempts: number, windowSeconds: number, now: Date): Promise<LoginAttemptResult> {
    return this.mutate(() => {
      const current = this.data.loginAttempts[key];
      const windowMs = windowSeconds * 1_000;
      const active = current && now.getTime() - Date.parse(current.windowStartedAt) < windowMs;
      const attempt = active ? { ...current, count: current.count + 1 } : { count: 1, windowStartedAt: now.toISOString() };
      this.data.loginAttempts[key] = attempt;
      return {
        allowed: attempt.count <= maxAttempts,
        retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(attempt.windowStartedAt) + windowMs - now.getTime()) / 1_000)),
      };
    });
  }
  async clearLoginAttempts(key: string) {
    await this.mutate(() => { delete this.data.loginAttempts[key]; });
  }
}
