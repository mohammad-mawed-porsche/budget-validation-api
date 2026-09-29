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

Generate an Argon2id password hash and prepare a local `auth-users.json` file:

```sh
npm run auth:hash-password -- 'use-a-password-manager-generated-password'
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

Upload the values as `SecureString` parameters. Omitting `--key-id` intentionally selects the AWS-managed SSM KMS key:

```sh
aws ssm put-parameter \
  --name /budget-validation/production/AUTH_SESSION_SECRET \
  --type SecureString \
  --value "$(openssl rand -base64 48)" \
  --overwrite

aws ssm put-parameter \
  --name /budget-validation/production/AUTH_USERS_JSON \
  --type SecureString \
  --value file://auth-users.json \
  --overwrite

aws ssm put-parameter \
  --name /budget-validation/production/MICROSOFT_CLIENT_SECRET \
  --type SecureString \
  --value 'YOUR_MICROSOFT_CLIENT_SECRET' \
  --overwrite

aws ssm put-parameter \
  --name /budget-validation/production/PRODUCTIVE_API_KEY \
  --type SecureString \
  --value 'YOUR_PRODUCTIVE_API_KEY' \
  --overwrite
```

Do not commit `auth-users.json`. Delete it securely after uploading it. Each Lambda retrieves only the two values it needs with `ssm:GetParameters` and `WithDecryption=true`, then caches them for the lifetime of the warm execution environment. Parameter values are not included in Lambda environment variables, CDK context, CloudFormation, or stack outputs.

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

Run a limited dry run through `POST /v1/runs`, inspect `GET /v1/runs/:runId`, and then enable the schedule:

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
