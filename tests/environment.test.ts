import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";

const environment = {
  NODE_ENV: "production", AUTH_MODE: "local-users", AUTH_USERS_JSON: '[{"username":"test"}]',
  AUTH_COOKIE_SECURE: "true", PRODUCTIVE_API_KEY: "test", PRODUCTIVE_ORG_ID: "test",
  MICROSOFT_TOKEN_URL: "https://login.example/token", MICROSOFT_CLIENT_ID: "test",
  MICROSOFT_CLIENT_SECRET: "test", HEIMDALL_SITE_ID: "test", HEIMDALL_LIST_ID: "test",
};

describe("production authentication configuration", () => {
  it("rejects the development signing secret", () => {
    expect(() => loadEnvironment(environment)).toThrow("unique AUTH_SESSION_SECRET");
  });
  it("rejects insecure refresh cookies", () => {
    expect(() => loadEnvironment({ ...environment, AUTH_SESSION_SECRET: "test-secret-".repeat(4), AUTH_COOKIE_SECURE: "false" })).toThrow("AUTH_COOKIE_SECURE=true");
  });
  it("accepts an explicitly configured secret and secure cookies", () => {
    expect(loadEnvironment({ ...environment, AUTH_SESSION_SECRET: "test-secret-".repeat(4) }).AUTH_COOKIE_SECURE).toBe(true);
  });
});
