import { afterEach, describe, expect, it, vi } from "vitest";
import { hash } from "argon2";

import type { HeimdallBudgetSource } from "../src/clients/heimdallClient.js";
import type { ProductiveBudgetSource } from "../src/clients/productiveClient.js";
import { buildApplication, type Application } from "../src/app.js";
import type { Environment } from "../src/config/env.js";
import { MemoryWorkflowRepository } from "../src/repositories/memoryWorkflowRepository.js";
import { MemoryAuthRepository } from "../src/repositories/memoryAuthRepository.js";

const environment: Environment = {
  HOST: "127.0.0.1",
  PORT: 3100,
  LOG_LEVEL: "silent",
  CORS_ORIGINS: "http://localhost:3000",
  TRUST_PROXY: false,
  AUTH_MODE: "static-token",
  API_TOKEN: "test-token-that-is-long-enough",
  AUTH_USERS_JSON: "[]",
  AUTH_SESSION_SECRET: "test-session-secret-with-32-characters",
  AUTH_ISSUER: "budget-validation-api",
  AUTH_AUDIENCE: "budget-validation-clients",
  AUTH_ACCESS_TTL_SECONDS: 900,
  AUTH_IDLE_TTL_SECONDS: 1_800,
  AUTH_ABSOLUTE_TTL_SECONDS: 43_200,
  AUTH_LOGIN_MAX_ATTEMPTS: 5,
  AUTH_LOGIN_WINDOW_SECONDS: 900,
  AUTH_COOKIE_NAME: "budget_refresh",
  AUTH_COOKIE_SECURE: false,
  AUTH_STORE_FILE: ".data/auth-test.json",
  PRODUCTIVE_BASE_URL: "https://productive.example/api/v2",
  PRODUCTIVE_API_KEY: "productive-key",
  PRODUCTIVE_ORG_ID: "org",
  PRODUCTIVE_COST_CENTER_FIELD_ID: "17450",
  PRODUCTIVE_PAGE_SIZE: 200,
  PRODUCTIVE_MAX_PAGES_PER_COST_ID: 5,
  PRODUCTIVE_MAX_CONCURRENCY: 2,
  PRODUCTIVE_MIN_REQUEST_INTERVAL_MS: 0,
  WORKFLOW_TIMEZONE: "Europe/Berlin",
  MICROSOFT_TOKEN_URL: "https://login.example/token",
  MICROSOFT_CLIENT_ID: "client",
  MICROSOFT_CLIENT_SECRET: "secret",
  MICROSOFT_SCOPE: "scope",
  MICROSOFT_GRAPH_BASE_URL: "https://graph.example/v1.0",
  HEIMDALL_SITE_ID: "site",
  HEIMDALL_LIST_ID: "list",
  HEIMDALL_MAX_LIST_PAGES: 20,
  HEIMDALL_BUDGET_VALID_TRUE_VALUE: "True",
  HEIMDALL_BUDGET_VALID_FALSE_VALUE: "False",
  REQUEST_TIMEOUT_MS: 1_000,
  UPSTREAM_MAX_RETRIES: 0,
  UPSTREAM_RETRY_BASE_MS: 1,
  STORAGE_FILE: ".data/test.json",
  STORAGE_DRIVER: "file",
  AWS_REGION: "eu-central-1",
  MAX_STORED_RUNS: 20,
  MAX_STORED_NOTIFICATIONS: 100,
  NOTIFICATION_COOLDOWN_DAYS: 7,
  SLACK_NOTIFICATIONS_ENABLED: false,
  SCHEDULER_POLL_INTERVAL_MS: 60_000,
  LOCAL_SCHEDULER_ENABLED: true,
  RUN_LOCK_TTL_SECONDS: 21_600,
  SCHEDULED_RUN_SCOPE: "all",
  SCHEDULED_RUN_DRY_RUN: false,
};

const productive: ProductiveBudgetSource = { findBudgetsByCostId: async () => [] };
const heimdall: HeimdallBudgetSource = { listAffiliations: async () => [], updateValidity: async () => {} };
let application: Application | null = null;

afterEach(async () => {
  await application?.app.close();
  application = null;
});

describe("API", () => {
  it("does not let forwarded headers bypass login throttling when proxy trust is disabled", async () => {
    const passwordHash = await hash("test-only-password", { type: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    application = await buildApplication({
      ...environment, AUTH_MODE: "local-users", AUTH_LOGIN_MAX_ATTEMPTS: 2,
      AUTH_USERS_JSON: JSON.stringify([{ username: "viewer", passwordHash, roles: ["viewer"] }]),
    }, { productive, heimdall, repository: new MemoryWorkflowRepository(), authRepository: new MemoryAuthRepository(), logger: false });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await application.app.inject({
        method: "POST", url: "/v1/auth/login", remoteAddress: "192.0.2.10",
        headers: { "x-forwarded-for": `198.51.100.${attempt}` },
        payload: { username: "viewer", password: "wrong" },
      });
      expect(result.statusCode).toBe(attempt < 3 ? 401 : 429);
    }
  });

  it("leaves health public and protects workflow endpoints", async () => {
    application = await buildApplication(environment, {
      productive,
      heimdall,
      repository: new MemoryWorkflowRepository(),
      // Exercise the real logger/redaction configuration; LOG_LEVEL is silent.
    });

    expect((await application.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const unauthorized = await application.app.inject({ method: "GET", url: "/v1/runs" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("Bearer");
    expect((await application.app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${environment.API_TOKEN}` },
    })).statusCode).toBe(200);
  });

  it("runs the workflow and validates schedule input", async () => {
    application = await buildApplication(environment, {
      productive,
      heimdall,
      repository: new MemoryWorkflowRepository(),
      logger: false,
      uuid: () => "00000000-0000-4000-8000-000000000001",
    });
    const headers = { authorization: `Bearer ${environment.API_TOKEN}` };
    const run = await application.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers,
      payload: { scope: "all", dryRun: true },
    });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ status: "running", runId: "00000000-0000-4000-8000-000000000001" });
    expect(run.headers.location).toBe("/v1/runs/00000000-0000-4000-8000-000000000001");

    const invalidSchedule = await application.app.inject({
      method: "PUT",
      url: "/v1/schedule",
      headers,
      payload: { enabled: true, time: "25:00", timezone: "Europe/Berlin", scope: "all", dryRun: false },
    });
    expect(invalidSchedule.statusCode).toBe(400);

    const schedule = await application.app.inject({
      method: "PUT",
      url: "/v1/schedule",
      headers,
      payload: { enabled: true, time: "06:30", timezone: "Europe/Berlin", scope: "all", dryRun: false },
    });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json()).toMatchObject({ enabled: true, time: "06:30", timezone: "Europe/Berlin" });
  });

  it("sends an authenticated Slack channel test through the configured publisher", async () => {
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    application = await buildApplication(environment, {
      productive,
      heimdall,
      repository: new MemoryWorkflowRepository(),
      notificationPublisher: publisher,
      logger: false,
    });

    const response = await application.app.inject({
      method: "POST",
      url: "/v1/notifications/test",
      headers: { authorization: `Bearer ${environment.API_TOKEN}` },
      payload: { message: "Channel delivery check" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "sent", requestId: expect.any(String) });
    expect(publisher.publish).toHaveBeenCalledWith({
      text: "Budget Validation API test\nChannel delivery check",
      blocks: expect.arrayContaining([
        expect.objectContaining({ type: "header" }),
        expect.objectContaining({ type: "section" }),
      ]),
    });
  });

  it("reports when Slack channel delivery is not configured", async () => {
    application = await buildApplication(environment, {
      productive,
      heimdall,
      repository: new MemoryWorkflowRepository(),
      logger: false,
    });

    const response = await application.app.inject({
      method: "POST",
      url: "/v1/notifications/test",
      headers: { authorization: `Bearer ${environment.API_TOKEN}` },
      payload: { message: "Channel delivery check" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "SLACK_DISABLED" } });
  });

  it("supports login, refresh cookies, and role authorization", async () => {
    const passwordHash = await hash("correct horse battery staple", { type: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    application = await buildApplication({
      ...environment,
      AUTH_MODE: "local-users",
      AUTH_USERS_JSON: JSON.stringify([{ username: "viewer", passwordHash, roles: ["viewer"] }]),
    }, {
      productive,
      heimdall,
      repository: new MemoryWorkflowRepository(),
      authRepository: new MemoryAuthRepository(),
      logger: false,
    });

    const login = await application.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "viewer", password: "correct horse battery staple" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["cache-control"]).toBe("no-store");
    const accessToken = login.json().accessToken as string;
    const setCookie = login.headers["set-cookie"];
    const refreshCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    expect(accessToken).toBeTruthy();
    expect(refreshCookie).toContain("budget_refresh=");

    const me = await application.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { username: "viewer", roles: ["viewer"] } });

    const forbidden = await application.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { scope: "all", dryRun: true },
    });
    expect(forbidden.statusCode).toBe(403);
    const forbiddenSchedule = await application.app.inject({ method: "PUT", url: "/v1/schedule", headers: { authorization: `Bearer ${accessToken}` }, payload: { enabled: false } });
    expect(forbiddenSchedule.statusCode).toBe(403);

    const forbiddenSlackTest = await application.app.inject({
      method: "POST",
      url: "/v1/notifications/test",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { message: "Not allowed" },
    });
    expect(forbiddenSlackTest.statusCode).toBe(403);

    const refresh = await application.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: refreshCookie as string },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().accessToken).not.toBe(accessToken);
    expect(refresh.headers["set-cookie"]).toContain("budget_refresh=");
  });
});
