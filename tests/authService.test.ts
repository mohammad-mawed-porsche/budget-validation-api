import { hash } from "argon2";
import { beforeAll, describe, expect, it } from "vitest";

import { MemoryAuthRepository } from "../src/repositories/memoryAuthRepository.js";
import { InvalidSessionError, LoginRateLimitError, SessionAuthService } from "../src/services/authService.js";

let passwordHash: string;
beforeAll(async () => { passwordHash = await hash("correct horse battery staple", { type: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }); });

function fixture() {
  let now = new Date("2026-09-16T08:00:00.000Z");
  let id = 0;
  const repository = new MemoryAuthRepository();
  const service = new SessionAuthService(repository, {
    sessionSecret: "a-secure-session-secret-with-at-least-32-bytes",
    issuer: "test-issuer",
    audience: "test-audience",
    accessTtlSeconds: 900,
    idleTtlSeconds: 1_800,
    absoluteTtlSeconds: 43_200,
    loginMaxAttempts: 2,
    loginWindowSeconds: 900,
    usersJson: JSON.stringify([{ username: "Admin", passwordHash, roles: ["admin", "operator", "viewer"] }]),
  }, () => now, () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
  return { repository, service, setNow: (value: string) => { now = new Date(value); } };
}

describe("SessionAuthService", () => {
  it("issues verifiable access tokens and stores only a refresh-token hash", async () => {
    const { repository, service } = fixture();
    const tokens = await service.login("admin", "correct horse battery staple", { ipAddress: "127.0.0.1", userAgent: "test" });

    await expect(service.authenticate(`Bearer ${tokens.accessToken}`)).resolves.toMatchObject({ username: "Admin", roles: ["admin", "operator", "viewer"] });
    const session = await repository.getSession(tokens.principal.sessionId);
    expect(session?.refreshTokenHash).not.toContain(tokens.refreshToken);
    expect(session?.refreshTokenHash).toHaveLength(43);
  });

  it("rotates refresh tokens and revokes the session when an old token is replayed", async () => {
    const { service } = fixture();
    const first = await service.login("admin", "correct horse battery staple", { ipAddress: "127.0.0.1", userAgent: "test" });
    const second = await service.refresh(first.refreshToken, { ipAddress: "127.0.0.1", userAgent: "test" });
    expect(second.refreshToken).not.toBe(first.refreshToken);

    await expect(service.refresh(first.refreshToken, { ipAddress: "127.0.0.1", userAgent: "test" })).rejects.toBeInstanceOf(InvalidSessionError);
    await expect(service.authenticate(`Bearer ${second.accessToken}`)).resolves.toBeNull();
  });

  it("enforces idle expiry and distributed login throttling", async () => {
    const { service, setNow } = fixture();
    const tokens = await service.login("admin", "correct horse battery staple", { ipAddress: "127.0.0.1", userAgent: "test" });
    setNow("2026-09-16T08:30:01.000Z");
    await expect(service.authenticate(`Bearer ${tokens.accessToken}`)).resolves.toBeNull();

    await expect(service.login("missing", "wrong", { ipAddress: "192.0.2.1", userAgent: null })).rejects.toThrow();
    await expect(service.login("missing", "wrong", { ipAddress: "192.0.2.1", userAgent: null })).rejects.toThrow();
    await expect(service.login("missing", "wrong", { ipAddress: "192.0.2.1", userAgent: null })).rejects.toBeInstanceOf(LoginRateLimitError);
  });
});
