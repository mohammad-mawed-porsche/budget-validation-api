import { createHash } from "node:crypto";
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
  const config = {
    sessionSecret: "a-secure-session-secret-with-at-least-32-bytes",
    issuer: "test-issuer",
    audience: "test-audience",
    accessTtlSeconds: 900,
    idleTtlSeconds: 1_800,
    absoluteTtlSeconds: 43_200,
    loginMaxAttempts: 2,
    loginWindowSeconds: 900,
    usersJson: JSON.stringify([{ username: "Admin", passwordHash, roles: ["admin", "operator", "viewer"] }]),
  };
  const service = new SessionAuthService(repository, config, () => now, () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
  return { repository, service, config, setNow: (value: string) => { now = new Date(value); } };
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

  it("does not revoke sessions using a forged refresh or logout token", async () => {
    const { service } = fixture();
    const first = await service.login("admin", "correct horse battery staple", { ipAddress: "127.0.0.1", userAgent: "test" });
    const forged = `${first.principal.sessionId}.${"x".repeat(43)}`;
    await expect(service.refresh(forged, { ipAddress: "127.0.0.1", userAgent: "test" })).rejects.toBeInstanceOf(InvalidSessionError);
    await service.logout(forged, undefined);
    await expect(service.authenticate(`Bearer ${first.accessToken}`)).resolves.not.toBeNull();
    await service.logout(first.refreshToken, undefined);
    await expect(service.authenticate(`Bearer ${first.accessToken}`)).resolves.toBeNull();
  });

  it("migrates the current legacy refresh token without accepting forged legacy tokens", async () => {
    const { service, repository } = fixture();
    const first = await service.login("admin", "correct horse battery staple", { ipAddress: "127.0.0.1", userAgent: "test" });
    const session = (await repository.getSession(first.principal.sessionId))!;
    const legacy = first.refreshToken.split(".").slice(0, 2).join(".");
    await repository.rotateSession(session.id, session.refreshTokenHash, { ...session, refreshTokenHash: createHash("sha256").update(legacy).digest("base64url") });
    const rotated = await service.refresh(legacy, { ipAddress: "127.0.0.1", userAgent: "test" });
    expect(rotated.refreshToken.split(".")).toHaveLength(3);
    await expect(service.refresh(legacy, { ipAddress: "127.0.0.1", userAgent: "test" })).rejects.toBeInstanceOf(InvalidSessionError);
    await expect(service.authenticate(`Bearer ${rotated.accessToken}`)).resolves.not.toBeNull();
  });

  it("rejects signed refresh tokens after the signing key changes, even if their stored hash matches", async () => {
    const { service, repository, config } = fixture();
    const first = await service.login("admin", "correct horse battery staple", { ipAddress: "127.0.0.1", userAgent: "test" });
    const updated = new SessionAuthService(repository, { ...config, sessionSecret: "a-different-test-signing-key-with-32-bytes" }, () => new Date("2026-09-16T08:00:01Z"));
    await expect(updated.authenticate(`Bearer ${first.accessToken}`)).resolves.toBeNull();
    await expect(updated.refresh(first.refreshToken, { ipAddress: "127.0.0.1", userAgent: "test" })).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it.each([{ disabled: true, roles: ["admin", "operator", "viewer"] }, { disabled: false, roles: ["viewer"] }])("rejects sessions after updated user configuration: %j", async (user) => {
    const { service, repository, config } = fixture();
    const first = await service.login("admin", "correct horse battery staple", { ipAddress: "127.0.0.1", userAgent: "test" });
    const updated = new SessionAuthService(repository, { ...config, usersJson: JSON.stringify([{ username: "Admin", passwordHash, ...user }]) }, () => new Date("2026-09-16T08:00:01Z"));
    await expect(updated.authenticate(`Bearer ${first.accessToken}`)).resolves.toBeNull();
    await expect(updated.refresh(first.refreshToken, { ipAddress: "127.0.0.1", userAgent: "test" })).rejects.toBeInstanceOf(InvalidSessionError);
  });
});
