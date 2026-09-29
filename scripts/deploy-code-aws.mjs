import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectDirectory = resolve(import.meta.dirname, "..");
const stackName = process.env.CDK_STACK_NAME?.trim() || "BudgetValidationStack";
const mode = process.argv.includes("--diff") ? "diff" : "deploy";
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--diff");

if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDirectory,
    env: process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

console.log(`Reading the deployed parameters for ${stackName}.`);
const parameterOutput = run("aws", [
  "cloudformation",
  "describe-stacks",
  "--stack-name",
  stackName,
  "--query",
  "Stacks[0].Parameters",
  "--output",
  "json",
], { capture: true });

const deployedParameters = JSON.parse(parameterOutput ?? "[]");
if (!Array.isArray(deployedParameters) || deployedParameters.length === 0) {
  throw new Error(`${stackName} has no deployed CloudFormation parameters.`);
}

const slackNotificationsEnabled = process.env.SLACK_NOTIFICATIONS_ENABLED?.trim().toLowerCase();
if (slackNotificationsEnabled) {
  if (!new Set(["true", "false"]).has(slackNotificationsEnabled)) {
    throw new Error("SLACK_NOTIFICATIONS_ENABLED must be true or false.");
  }
}

console.log("Running the application, infrastructure, and synthesis checks.");
run("npm", ["run", "infra:check"]);

console.log(`${mode === "diff" ? "Diffing" : "Deploying"} ${stackName} without changing SSM values.`);
const cdkArguments = [
  "run",
  mode,
  "--prefix",
  "infra",
  "--",
  stackName,
];
if (mode === "deploy") {
  cdkArguments.push("--previous-parameters", "--require-approval", "never");
  if (slackNotificationsEnabled) {
    cdkArguments.push(
      "--parameters",
      `${stackName}:SlackNotificationsEnabled=${slackNotificationsEnabled}`,
    );
  }
}
run("npm", cdkArguments);
