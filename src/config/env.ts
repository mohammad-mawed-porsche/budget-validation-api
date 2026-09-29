import "dotenv/config";

import { z } from "zod";

const booleanString = (defaultValue: "true" | "false") =>
  z.enum(["true", "false"]).default(defaultValue).transform((value) => value === "true");

const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  TRUST_PROXY: booleanString("false"),
  AUTH_MODE: z.enum(["local-users", "static-token"]).default("local-users"),
  API_TOKEN: z.string().min(24).optional(),
  AUTH_USERS_JSON: z.string().default("[]"),
  AUTH_SESSION_SECRET: z.string().min(32).default("local-development-secret-change-me-now"),
  AUTH_ISSUER: z.string().default("budget-validation-api"),
  AUTH_AUDIENCE: z.string().default("budget-validation-clients"),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  AUTH_IDLE_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1_800),
  AUTH_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(900).max(604_800).default(43_200),
  AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  AUTH_LOGIN_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  AUTH_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("budget_refresh"),
  AUTH_COOKIE_SECURE: booleanString("false"),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  AUTH_STORE_FILE: z.string().default(".data/auth-store.json"),

  PRODUCTIVE_BASE_URL: z.url().default("https://api.productive.io/api/v2"),
  PRODUCTIVE_API_KEY: z.string().min(1),
  PRODUCTIVE_ORG_ID: z.string().min(1),
  PRODUCTIVE_COST_CENTER_FIELD_ID: z.string().default("17450"),
  PRODUCTIVE_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(200),
  PRODUCTIVE_MAX_PAGES_PER_COST_ID: z.coerce.number().int().min(1).max(100).default(5),
  PRODUCTIVE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  PRODUCTIVE_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().nonnegative().default(125),
  WORKFLOW_TIMEZONE: z.string().default("Europe/Berlin"),

  MICROSOFT_TOKEN_URL: z.url(),
  MICROSOFT_CLIENT_ID: z.string().min(1),
  MICROSOFT_CLIENT_SECRET: z.string().min(1),
  MICROSOFT_SCOPE: z.string().default("https://graph.microsoft.com/.default"),
  MICROSOFT_GRAPH_BASE_URL: z.url().default("https://graph.microsoft.com/v1.0"),
  HEIMDALL_SITE_ID: z.string().min(1),
  HEIMDALL_LIST_ID: z.string().min(1),
  HEIMDALL_MAX_LIST_PAGES: z.coerce.number().int().min(1).max(100).default(20),
  HEIMDALL_BUDGET_VALID_TRUE_VALUE: z.string().default("True"),
  HEIMDALL_BUDGET_VALID_FALSE_VALUE: z.string().default("False"),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  UPSTREAM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  UPSTREAM_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),
  STORAGE_FILE: z.string().default(".data/workflow-store.json"),
  STORAGE_DRIVER: z.enum(["file", "dynamodb"]).default("file"),
  DYNAMODB_TABLE_NAME: z.string().optional(),
  WORKFLOW_QUEUE_URL: z.url().optional(),
  AWS_REGION: z.string().default("eu-central-1"),
  MAX_STORED_RUNS: z.coerce.number().int().positive().default(200),
  MAX_STORED_NOTIFICATIONS: z.coerce.number().int().positive().default(5_000),
  NOTIFICATION_COOLDOWN_DAYS: z.coerce.number().positive().default(7),
  SLACK_NOTIFICATIONS_ENABLED: booleanString("false"),
  SLACK_WEBHOOK_URL: z.string().optional(),
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  LOCAL_SCHEDULER_ENABLED: booleanString("true"),
  RUN_LOCK_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(21_600),
  SCHEDULED_RUN_SCOPE: z.enum(["all", "limit"]).default("all"),
  SCHEDULED_RUN_LIMIT: z.coerce.number().int().min(1).max(10_000).optional(),
  SCHEDULED_RUN_DRY_RUN: booleanString("false"),
}).superRefine((value, context) => {
  if (value.AUTH_MODE === "static-token" && !value.API_TOKEN) {
    context.addIssue({ code: "custom", path: ["API_TOKEN"], message: "API_TOKEN is required in static-token mode." });
  }
  if (value.AUTH_MODE === "local-users") {
    try {
      const users = JSON.parse(value.AUTH_USERS_JSON) as unknown;
      if (!Array.isArray(users) || users.length === 0) throw new Error();
    } catch {
      context.addIssue({ code: "custom", path: ["AUTH_USERS_JSON"], message: "AUTH_USERS_JSON must contain at least one user." });
    }
  }
  if (value.STORAGE_DRIVER === "dynamodb" && !value.DYNAMODB_TABLE_NAME) {
    context.addIssue({ code: "custom", path: ["DYNAMODB_TABLE_NAME"], message: "DYNAMODB_TABLE_NAME is required for DynamoDB storage." });
  }
  if (value.SCHEDULED_RUN_SCOPE === "limit" && !value.SCHEDULED_RUN_LIMIT) {
    context.addIssue({ code: "custom", path: ["SCHEDULED_RUN_LIMIT"], message: "SCHEDULED_RUN_LIMIT is required for limited scheduled runs." });
  }
  if (value.SLACK_NOTIFICATIONS_ENABLED) {
    try {
      const url = new URL(value.SLACK_WEBHOOK_URL ?? "");
      if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/")) throw new Error();
    } catch {
      context.addIssue({ code: "custom", path: ["SLACK_WEBHOOK_URL"], message: "A valid Slack incoming webhook URL is required when Slack notifications are enabled." });
    }
  }
});

export type Environment = z.infer<typeof schema>;

export function loadEnvironment(environment: NodeJS.ProcessEnv = process.env): Environment {
  const result = schema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
