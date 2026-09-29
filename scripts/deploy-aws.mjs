import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const projectDirectory = resolve(import.meta.dirname, "..");
const environmentFile = resolve(
  process.env.DEPLOY_ENV_FILE ?? resolve(projectDirectory, ".env"),
);
const values = parse(readFileSync(environmentFile));

function optional(...names) {
  for (const name of names) {
    const value = values[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function required(...names) {
  const value = optional(...names);
  if (!value) throw new Error(`${names.join(" or ")} is missing from ${environmentFile}.`);
  return value;
}

const legacySharePointEnvironment = optional("SHAREPOINT_ENVIRONMENT")?.toLowerCase();
if (legacySharePointEnvironment && !new Set(["test", "production"]).has(legacySharePointEnvironment)) {
  throw new Error("SHAREPOINT_ENVIRONMENT must be either test or production.");
}
const deploymentEnvironment = (optional("DEPLOY_ENVIRONMENT") ?? legacySharePointEnvironment ?? "production").toLowerCase();
const legacySiteKey = legacySharePointEnvironment === "production" ? "SHAREPOINT_PRODUCTION_SITE_ID" : "SHAREPOINT_TEST_SITE_ID";
const legacyListKey = legacySharePointEnvironment === "production" ? "SHAREPOINT_PRODUCTION_LIST_ID" : "SHAREPOINT_TEST_LIST_ID";
const siteId = optional("HEIMDALL_SITE_ID") ?? required(legacySiteKey);
const listId = optional("HEIMDALL_LIST_ID") ?? required(legacyListKey);
const allowedOrigins = required("CORS_ORIGINS", "DASHBOARD_ORIGIN");
const productiveOrganizationId = required("PRODUCTIVE_ORG_ID", "ORG_ID");
const microsoftTokenUrl = required("MICROSOFT_TOKEN_URL", "ACCESS_TOKEN_URL");
const microsoftClientId = required("MICROSOFT_CLIENT_ID", "CLIENT_ID");
const budgetValidTrueValue = required("HEIMDALL_BUDGET_VALID_TRUE_VALUE", "BUDGET_VALID_TRUE_VALUE");
const budgetValidFalseValue = required("HEIMDALL_BUDGET_VALID_FALSE_VALUE", "BUDGET_VALID_FALSE_VALUE");
const sessionSecret = required("AUTH_SESSION_SECRET", "DASHBOARD_SESSION_SECRET");
const slackWebhookUrl = optional("SLACK_WEBHOOK_URL");
const slackNotificationsEnabled = (optional("SLACK_NOTIFICATIONS_ENABLED") ?? (slackWebhookUrl ? "true" : "false")).toLowerCase();
if (sessionSecret.length < 32) throw new Error("DASHBOARD_SESSION_SECRET must contain at least 32 characters.");
if (!new Set(["true", "false"]).has(slackNotificationsEnabled)) {
  throw new Error("SLACK_NOTIFICATIONS_ENABLED must be true or false.");
}
if (slackNotificationsEnabled === "true") {
  if (!slackWebhookUrl) throw new Error("SLACK_WEBHOOK_URL is required when Slack notifications are enabled.");
  const url = new URL(slackWebhookUrl);
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/")) {
    throw new Error("SLACK_WEBHOOK_URL must be an HTTPS hooks.slack.com/services URL.");
  }
}

let authUsersJson = optional("AUTH_USERS_JSON");
if (!authUsersJson) {
  const username = required("DASHBOARD_USER");
  // Next.js dotenv files escape "$" to prevent interpolation; SSM needs the raw PHC string.
  const passwordHash = required("DASHBOARD_PASSWORD_HASH").replaceAll("\\$", "$");
  if (!passwordHash.startsWith("$argon2")) throw new Error("DASHBOARD_PASSWORD_HASH must be an Argon2 hash.");
  authUsersJson = JSON.stringify([{
    username,
    passwordHash,
    roles: ["admin", "operator", "viewer"],
    disabled: false,
  }]);
}
try {
  const users = JSON.parse(authUsersJson);
  if (!Array.isArray(users) || users.length === 0) throw new Error();
} catch {
  throw new Error("AUTH_USERS_JSON must contain a non-empty JSON array.");
}

const parameterPrefix = process.env.SECURE_PARAMETER_PREFIX ?? `/budget-validation/${deploymentEnvironment}`;
const secureParameters = {
  AUTH_SESSION_SECRET: sessionSecret,
  AUTH_USERS_JSON: authUsersJson,
  MICROSOFT_CLIENT_SECRET: required("MICROSOFT_CLIENT_SECRET", "CLIENT_SECRET"),
  PRODUCTIVE_API_KEY: required("PRODUCTIVE_API_KEY", "API_KEY"),
  ...(slackWebhookUrl ? { SLACK_WEBHOOK_URL: slackWebhookUrl } : {}),
};

const ssm = new SSMClient({});
for (const [name, value] of Object.entries(secureParameters)) {
  const parameterName = `${parameterPrefix}/${name}`;
  await ssm.send(new PutParameterCommand({
    Name: parameterName,
    Type: "SecureString",
    Tier: "Standard",
    Value: value,
    Overwrite: true,
  }));
  console.log(`Synced ${parameterName}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDirectory,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Deploying the ${deploymentEnvironment} configuration with the daily schedule disabled.`);
run("npm", ["run", "build"]);
run("npm", [
  "run", "deploy", "--prefix", "infra", "--",
  "--require-approval", "never",
  "--parameters", `AllowedOrigins=${allowedOrigins}`,
  "--parameters", `SecureParameterPrefix=${parameterPrefix}`,
  "--parameters", `ProductiveOrganizationId=${productiveOrganizationId}`,
  "--parameters", `MicrosoftTokenUrl=${microsoftTokenUrl}`,
  "--parameters", `MicrosoftClientId=${microsoftClientId}`,
  "--parameters", `HeimdallSiteId=${siteId}`,
  "--parameters", `HeimdallListId=${listId}`,
  "--parameters", `HeimdallBudgetValidTrueValue=${budgetValidTrueValue}`,
  "--parameters", `HeimdallBudgetValidFalseValue=${budgetValidFalseValue}`,
  "--parameters", `SlackNotificationsEnabled=${slackNotificationsEnabled}`,
  "--parameters", "DailyScheduleState=DISABLED",
]);
