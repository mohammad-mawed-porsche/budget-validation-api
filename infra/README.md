# AWS CDK deployment

This TypeScript CDK application deploys the budget validation API as a serverless workload. CDK is the infrastructure source of truth; there are no handwritten CloudFormation templates.

## Architecture

The rendered diagram and a short flow description are in [../docs/architecture.md](../docs/architecture.md).

```text
Frontend -> API Gateway HTTP API -> API Lambda -> SQS -> Workflow Lambda
                                             ^
                                             |
                                  EventBridge Scheduler

API Lambda + Workflow Lambda -> DynamoDB
API Lambda -> auth + Slack SecureString parameters
Workflow Lambda -> integration + Slack SecureString parameters
Workflow Lambda -> Productive + Microsoft Graph/Heimdall + Slack incoming webhook
API Lambda -> Slack incoming webhook for authenticated test messages
```

Resources:

- API Gateway HTTP API and Fastify API Lambda.
- SQS workflow queue and dead-letter queue.
- One reserved-concurrency workflow Lambda triggered with batches of one message.
- EventBridge Scheduler for the daily run.
- Authenticated schedule updates change the real EventBridge Scheduler expression, timezone, state, and queued run payload.
- Encrypted DynamoDB single-table state with point-in-time recovery, TTL, deletion protection, and a history index.
- SSM Parameter Store `SecureString` credentials encrypted with the AWS-managed SSM KMS key (`alias/aws/ssm`).
- CloudWatch logs, dashboard, Lambda and dead-letter queue alarms, and an SNS alarm topic.
- X-Ray active tracing for both Lambda functions.

There is no Fargate, ECS, VPC, NAT gateway, load balancer, Secrets Manager, or Docker requirement. The Lambdas remain outside a customer VPC so they can reach Productive and Microsoft Graph without a NAT gateway.

The daily schedule is disabled by default. Enable it only after the required secure parameters are present and a manual dry run succeeds.

## Prerequisites

- Node.js 22+
- AWS CLI credentials for the target account
- AWS CDK bootstrapped in the account and region

```sh
cd infra
npm install
npx cdk bootstrap aws://ACCOUNT_ID/eu-central-1
cd ..
npm install
```

## Build and verify

Run this from `budget-validation-api` so the optimized Lambda zip directory is created before CDK synthesis:

```sh
npm run infra:check
```

The optimized `.lambda` directory includes the Linux x64 Argon2 binary required by the custom authentication system; the build fails if that binary is missing.

## Create the secure parameters

CloudFormation cannot create SSM `SecureString` resources. Create these required values before deploying or starting the Lambdas:

```text
/budget-validation/production/AUTH_SESSION_SECRET
/budget-validation/production/AUTH_USERS_JSON
/budget-validation/production/MICROSOFT_CLIENT_SECRET
/budget-validation/production/PRODUCTIVE_API_KEY
```

To enable Slack delivery, also create this optional `SecureString` and deploy with `SlackNotificationsEnabled=true`:

```text
/budget-validation/production/SLACK_WEBHOOK_URL
```

Generate an Argon2id password hash without putting the password in shell history
or process arguments (run from the API repository root in zsh):

```zsh
read -s "NEW_PASSWORD?New API password: "; echo
printf '%s' "$NEW_PASSWORD" | npm run --silent auth:hash-password
unset NEW_PASSWORD
```

The JSON value must look like this:

```json
[
  {
    "username": "admin",
    "passwordHash": "$argon2id$...",
    "roles": ["admin", "operator", "viewer"],
    "disabled": false
  }
]
```

In the correct AWS account and region, use Systems Manager → Parameter Store
to create the listed parameters as **SecureString**, using the AWS-managed
SSM KMS key (`alias/aws/ssm`). Store the JSON above in `AUTH_USERS_JSON`, with
the generated hash in `passwordHash`, never the plaintext password. Keep the
original password and a random `AUTH_SESSION_SECRET` in an approved password
manager. Do not paste secret values into CLI arguments, source files or screenshots.

For an existing environment, update only the intended parameter. Do not replace
working production values from a stale local `.env`; see the
[secret rotation procedure](../docs/deployment.md#configuration-and-secret-deployment).

Each Lambda retrieves its permitted values with `ssm:GetParameters` and
`WithDecryption=true`, then caches them for the lifetime of the warm execution
environment. The API reads authentication parameters; the worker reads
integration parameters. Both can read the Slack webhook when delivery is
enabled. Parameter values are not included in Lambda environment variables,
CDK context, CloudFormation, or stack outputs.

## Deploy

For an existing stack, the safe release path is the code-only deployment described in [../docs/deployment.md](../docs/deployment.md). It carries forward the deployed CloudFormation parameters and never overwrites SSM secrets:

```sh
npm run aws:diff:code
npm run aws:deploy:code
```

The explicit command below is primarily for the first deployment or an intentional parameter change.

The non-secret identifiers are CloudFormation parameters:

```sh
npm run infra:deploy -- \
  --parameters AllowedOrigins=https://your-frontend.example.com \
  --parameters SecureParameterPrefix=/budget-validation/production \
  --parameters ProductiveOrganizationId=YOUR_PRODUCTIVE_ORG_ID \
  --parameters MicrosoftTokenUrl=https://login.microsoftonline.com/YOUR_TENANT/oauth2/v2.0/token \
  --parameters MicrosoftClientId=YOUR_MICROSOFT_CLIENT_ID \
  --parameters HeimdallSiteId=YOUR_HEIMDALL_SITE_ID \
  --parameters HeimdallListId=YOUR_HEIMDALL_LIST_ID \
  --parameters HeimdallBudgetValidTrueValue=Yes \
  --parameters HeimdallBudgetValidFalseValue=No \
  --parameters DailyScheduleExpression='cron(0 6 * * ? *)' \
  --parameters DailyScheduleTimezone=Europe/Berlin \
  --parameters DailyScheduleState=DISABLED
```

CDK outputs the API URL, DynamoDB table, workflow queue, dead-letter queue, parameter prefix, and alarm topic.

Run a limited dry run through `POST /v1/runs` and inspect `GET /v1/runs/:runId`. After validation, enable and edit the schedule through authenticated `PUT /v1/schedule` or the frontend operations panel. The API updates EventBridge directly with a resource-scoped IAM permission.

The CDK parameters below remain useful for setting an initial schedule during infrastructure deployment:

```sh
npm run infra:deploy -- \
  --parameters ProductiveOrganizationId=YOUR_PRODUCTIVE_ORG_ID \
  --parameters MicrosoftTokenUrl=https://login.microsoftonline.com/YOUR_TENANT/oauth2/v2.0/token \
  --parameters MicrosoftClientId=YOUR_MICROSOFT_CLIENT_ID \
  --parameters HeimdallSiteId=YOUR_HEIMDALL_SITE_ID \
  --parameters HeimdallListId=YOUR_HEIMDALL_LIST_ID \
  --parameters DailyScheduleState=ENABLED
```

Pass the same parameter values used on the first deployment, or store them in your deployment pipeline.

## Execution behavior

- `POST /v1/runs` saves a `queued` run, sends one SQS message, and returns `202 Accepted` immediately.
- EventBridge sends the same message format to SQS once per day.
- The workflow Lambda has a 15-minute timeout and reserved concurrency of one.
- SQS retries failed messages three times before sending them to the dead-letter queue.
- The repository-backed lock prevents a manual and scheduled run from overlapping.
- An abort signal stops network work shortly before the Lambda timeout so the run can be marked failed and the lock released.
- Notification cooldown and authentication session state remain in DynamoDB.

The current worker processes one complete run per invocation. If production execution approaches the 15-minute Lambda limit, the next scaling step is checkpointed Cost-ID chunks, not a return to Fargate.

## Authentication

Authentication remains application-owned rather than Cognito:

- Argon2id password verification
- short-lived signed access tokens
- opaque rotating refresh tokens in `HttpOnly`, `Secure`, `SameSite=Strict` cookies
- DynamoDB revocation, idle expiry, absolute expiry, and replay detection
- login throttling and role-based authorization

Never put plaintext passwords, API keys, signing keys, or Microsoft client secrets in CDK parameters, source files, Lambda environment variables, or stack outputs.
