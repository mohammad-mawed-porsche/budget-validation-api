import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";

import { HeimdallClient, type HeimdallBudgetSource } from "./clients/heimdallClient.js";
import { ProductiveClient, type ProductiveBudgetSource } from "./clients/productiveClient.js";
import { SlackWebhookClient, type NotificationPublisher } from "./clients/slackWebhookClient.js";
import type { Environment } from "./config/env.js";
import { sendApiError } from "./http.js";
import { registerAuthentication } from "./middleware/auth.js";
import { FileWorkflowRepository } from "./repositories/fileWorkflowRepository.js";
import { FileAuthRepository } from "./repositories/fileAuthRepository.js";
import { DynamoStateRepository } from "./repositories/dynamoStateRepository.js";
import type { AuthRepository } from "./repositories/authRepository.js";
import type { WorkflowRepository } from "./repositories/workflowRepository.js";
import { registerHealthRoutes } from "./routes/healthRoutes.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerNotificationRoutes } from "./routes/notificationRoutes.js";
import { registerRunRoutes } from "./routes/runRoutes.js";
import { registerScheduleRoutes } from "./routes/scheduleRoutes.js";
import { SessionAuthService, StaticBearerAuthService, type AuthService, type InteractiveAuthService } from "./services/authService.js";
import { NotificationService } from "./services/notificationService.js";
import { EventBridgeScheduleController } from "./services/eventBridgeScheduleController.js";
import { SqsRunDispatcher, type RunStarter } from "./services/runDispatcher.js";
import { ScheduleService } from "./services/scheduleService.js";
import { WorkflowAlreadyRunningError, WorkflowRunFailedError, WorkflowService } from "./services/workflowService.js";

export interface ApplicationOverrides {
  productive?: ProductiveBudgetSource;
  heimdall?: HeimdallBudgetSource;
  repository?: WorkflowRepository;
  auth?: AuthService;
  authRepository?: AuthRepository;
  now?: () => Date;
  uuid?: () => string;
  logger?: false;
  runStarter?: RunStarter;
  notificationPublisher?: NotificationPublisher;
}

export interface Application {
  app: FastifyInstance;
  workflow: WorkflowService;
  schedule: ScheduleService;
  repository: WorkflowRepository;
}

export async function buildApplication(environment: Environment, overrides: ApplicationOverrides = {}): Promise<Application> {
  const app = Fastify({
    bodyLimit: 16_384,
    trustProxy: environment.TRUST_PROXY,
    genReqId: (request) => typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : crypto.randomUUID(),
    logger: overrides.logger === false ? false : {
      level: environment.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-api-key",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "req.body.password",
          "password",
          "accessToken",
          "refreshToken",
          "AUTH_SESSION_SECRET",
          "AUTH_USERS_JSON",
          "PRODUCTIVE_API_KEY",
          "MICROSOFT_CLIENT_SECRET",
          "SLACK_WEBHOOK_URL",
        ],
        censor: "[REDACTED]",
      },
    },
  });
  await app.register(helmet);
  await app.register(cookie);
  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/")) reply.header("Cache-Control", "no-store");
  });
  await app.register(cors, {
    origin: environment.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    credentials: environment.AUTH_MODE === "local-users",
  });

  const dynamoRepository = environment.STORAGE_DRIVER === "dynamodb"
    ? new DynamoStateRepository({
      tableName: environment.DYNAMODB_TABLE_NAME as string,
      region: environment.AWS_REGION,
    })
    : null;
  const repository = overrides.repository ?? dynamoRepository ?? new FileWorkflowRepository(
      path.resolve(environment.STORAGE_FILE),
      { runs: environment.MAX_STORED_RUNS, notifications: environment.MAX_STORED_NOTIFICATIONS },
    );
  await repository.initialize();

  const productive = overrides.productive ?? new ProductiveClient({
    baseUrl: environment.PRODUCTIVE_BASE_URL,
    apiKey: environment.PRODUCTIVE_API_KEY,
    organizationId: environment.PRODUCTIVE_ORG_ID,
    costCenterFieldId: environment.PRODUCTIVE_COST_CENTER_FIELD_ID,
    pageSize: environment.PRODUCTIVE_PAGE_SIZE,
    maxPagesPerCostId: environment.PRODUCTIVE_MAX_PAGES_PER_COST_ID,
    minRequestIntervalMs: environment.PRODUCTIVE_MIN_REQUEST_INTERVAL_MS,
    timeoutMs: environment.REQUEST_TIMEOUT_MS,
    maxRetries: environment.UPSTREAM_MAX_RETRIES,
    retryBaseMs: environment.UPSTREAM_RETRY_BASE_MS,
  });
  const heimdall = overrides.heimdall ?? new HeimdallClient({
    tokenUrl: environment.MICROSOFT_TOKEN_URL,
    clientId: environment.MICROSOFT_CLIENT_ID,
    clientSecret: environment.MICROSOFT_CLIENT_SECRET,
    scope: environment.MICROSOFT_SCOPE,
    graphBaseUrl: environment.MICROSOFT_GRAPH_BASE_URL,
    siteId: environment.HEIMDALL_SITE_ID,
    listId: environment.HEIMDALL_LIST_ID,
    maxListPages: environment.HEIMDALL_MAX_LIST_PAGES,
    trueValue: environment.HEIMDALL_BUDGET_VALID_TRUE_VALUE,
    falseValue: environment.HEIMDALL_BUDGET_VALID_FALSE_VALUE,
    timeoutMs: environment.REQUEST_TIMEOUT_MS,
    maxRetries: environment.UPSTREAM_MAX_RETRIES,
    retryBaseMs: environment.UPSTREAM_RETRY_BASE_MS,
  });
  const authRepository = overrides.authRepository ?? dynamoRepository ?? new FileAuthRepository(path.resolve(environment.AUTH_STORE_FILE));
  await authRepository.initialize();
  const auth = overrides.auth ?? (environment.AUTH_MODE === "static-token"
    ? new StaticBearerAuthService(environment.API_TOKEN as string)
    : new SessionAuthService(authRepository, {
      sessionSecret: environment.AUTH_SESSION_SECRET,
      issuer: environment.AUTH_ISSUER,
      audience: environment.AUTH_AUDIENCE,
      accessTtlSeconds: environment.AUTH_ACCESS_TTL_SECONDS,
      idleTtlSeconds: environment.AUTH_IDLE_TTL_SECONDS,
      absoluteTtlSeconds: environment.AUTH_ABSOLUTE_TTL_SECONDS,
      loginMaxAttempts: environment.AUTH_LOGIN_MAX_ATTEMPTS,
      loginWindowSeconds: environment.AUTH_LOGIN_WINDOW_SECONDS,
      usersJson: environment.AUTH_USERS_JSON,
    }, overrides.now, overrides.uuid));
  const notificationPublisher = overrides.notificationPublisher ?? (environment.SLACK_NOTIFICATIONS_ENABLED
    ? new SlackWebhookClient({
      webhookUrl: environment.SLACK_WEBHOOK_URL as string,
      timeoutMs: environment.REQUEST_TIMEOUT_MS,
      maxRetries: environment.UPSTREAM_MAX_RETRIES,
      retryBaseMs: environment.UPSTREAM_RETRY_BASE_MS,
    })
    : undefined);
  const notifications = new NotificationService(
    repository,
    environment.NOTIFICATION_COOLDOWN_DAYS * 24 * 60 * 60 * 1_000,
    overrides.now,
    overrides.uuid,
    notificationPublisher,
  );
  const workflow = new WorkflowService(productive, heimdall, notifications, repository, {
    productiveConcurrency: environment.PRODUCTIVE_MAX_CONCURRENCY,
    timezone: environment.WORKFLOW_TIMEZONE,
    lockTtlSeconds: environment.RUN_LOCK_TTL_SECONDS,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.uuid ? { uuid: overrides.uuid } : {}),
  });
  const runStarter = overrides.runStarter ?? (environment.WORKFLOW_QUEUE_URL
    ? new SqsRunDispatcher(workflow, environment.WORKFLOW_QUEUE_URL)
    : workflow);
  const schedule = new ScheduleService(
    repository,
    workflow,
    app.log,
    environment.SCHEDULER_POLL_INTERVAL_MS,
    overrides.now,
    environment.EVENTBRIDGE_SCHEDULE_NAME
      ? new EventBridgeScheduleController(environment.EVENTBRIDGE_SCHEDULE_NAME, environment.AWS_REGION)
      : undefined,
  );

  registerAuthentication(app, auth);
  if ("login" in auth && typeof auth.login === "function") {
    registerAuthRoutes(app, auth as InteractiveAuthService, {
      name: environment.AUTH_COOKIE_NAME,
      secure: environment.AUTH_COOKIE_SECURE,
      ...(environment.AUTH_COOKIE_DOMAIN ? { domain: environment.AUTH_COOKIE_DOMAIN } : {}),
    });
  }
  registerHealthRoutes(app, workflow);
  registerRunRoutes(app, workflow, runStarter);
  registerScheduleRoutes(app, schedule);
  registerNotificationRoutes(app, repository, notificationPublisher);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkflowAlreadyRunningError) {
      return sendApiError(reply, 409, request.id, "RUN_IN_PROGRESS", error.message, { activeRunId: error.runId });
    }
    if (error instanceof WorkflowRunFailedError) {
      request.log.error({ err: error, runId: error.run.id }, "Budget validation run failed");
      return sendApiError(reply, 502, request.id, "RUN_FAILED", error.message, { runId: error.run.id });
    }
    request.log.error({ err: error }, "Unhandled API error");
    return sendApiError(reply, 500, request.id, "INTERNAL_ERROR", "The request could not be completed.");
  });

  app.addHook("onClose", async () => schedule.stop());
  await app.ready();
  if (environment.LOCAL_SCHEDULER_ENABLED) schedule.start();
  return { app, workflow, schedule, repository };
}
