# Budget Validation API

A standalone Fastify/TypeScript service for the **Budget validation** workflow:

1. Read active affiliations and Cost IDs from Heimdall (SharePoint through Microsoft Graph).
2. Query Productive by each unique Cost ID using custom field `17450`.
3. Select the single budget whose date range is active today.
4. Validate its total and usage.
5. Update Heimdall only when the result is definitive and changed.
6. Send an invalid-budget alert to the configured Slack channel, identifying the
   affected owners, subject to a seven-day cooldown. Without Slack enabled, save
   the prepared notification instead.

This folder contains only the workflow API. It does not copy the dashboard or other `frontend-vis` features.

See [docs/architecture.md](docs/architecture.md) for the request flow and the PNG architecture diagram. The SSO, CDK, secret-handling, verification, and rollback procedure is in [docs/deployment.md](docs/deployment.md).

[SECURITY.md](SECURITY.md) explains authentication, roles, encryption, secret
access, logging, rotation and the limits of the current implementation.

## Important behavior

The workflow uses three decisions:

- `valid`: one active Productive budget exists, its total is positive, and usage does not exceed the total.
- `invalid`: one active budget exists and either its total is not positive or its usage exceeds its total.
- `unknown`: Productive data is missing, incomplete, outside an active period, ambiguous, or unavailable.

`unknown` is deliberately non-destructive. It never writes `Invalid` to Heimdall. This makes the workflow safe in the test environment where a complete Productive snapshot is unavailable.

The returned and stored result retains the Cost ID plus the matched Productive budget ID, name, number, currency, period, financials, responsible ID, custom fields, affiliation, and owner data.

## Project layout

```text
src/
  clients/        Productive and Microsoft Graph/Heimdall adapters
  config/         environment and SSM parameter loading
  domain/         models, validation rules, and shared queue contracts
  middleware/     bearer authentication
  repositories/   DynamoDB and local storage adapters
  routes/         HTTP validation, handlers, and registration
  services/       workflow, notification cooldown, auth, scheduler
  utils/          concurrency and upstream retry helpers
  lambda/         API Gateway and SQS entrypoints
  app.ts          dependency composition
  http.ts         shared API error responses
  server.ts       local development entrypoint
```

## Local setup

Requirements: Node.js 22 or newer.

```sh
cp .env.example .env
npm ci
npm run dev
```

Generate an Argon2id password hash, place it in `AUTH_USERS_JSON`, set a random `AUTH_SESSION_SECRET`, and fill in the Productive and Microsoft credentials before starting:

```zsh
read -s "NEW_PASSWORD?New API password: "; echo
printf '%s' "$NEW_PASSWORD" | npm run --silent auth:hash-password
unset NEW_PASSWORD
```

The hashing script reads stdin only; do not put passwords in command arguments
or shell history. Its output is an Argon2id hash, not the original password.
Production local-user mode rejects the development signing secret and requires
secure refresh cookies. Keep signing secrets random and different from the
dashboard's signing secret.

Login returns a short-lived access token and sets a rotating refresh token in an `HttpOnly` cookie. Protected requests use:

```http
Authorization: Bearer <ACCESS_TOKEN>
```

`GET /health` and `GET /ready` are public process checks. They do not establish
that Productive, Heimdall or Slack are working, or report worker progress across
separate Lambda processes.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Readiness and current run ID |
| `POST` | `/v1/auth/login` | Verify an Argon2id password and begin a session |
| `POST` | `/v1/auth/refresh` | Rotate the refresh token and issue a new access token |
| `POST` | `/v1/auth/logout` | Revoke the current session |
| `GET` | `/v1/auth/me` | Read the authenticated identity and roles |
| `POST` | `/v1/runs` | Start the workflow asynchronously (`202 Accepted`) |
| `GET` | `/v1/runs?limit=20` | List persisted runs |
| `GET` | `/v1/runs/:runId` | Read one run and all Cost ID results |
| `GET` | `/v1/schedule` | Read the daily schedule |
| `PUT` | `/v1/schedule` | Configure the daily schedule |
| `GET` | `/v1/notifications?limit=50` | List notification records (prepared, sent or failed) |
| `POST` | `/v1/notifications/test` | Send a test message to the configured Slack channel |

Run ten affiliations without writing to Heimdall or preparing notifications:

```sh
read -s "PASSWORD?API password: "; echo
ACCESS_TOKEN=$(printf '%s' "$PASSWORD" | jq -Rs '{username:"admin",password:.}' | \
  curl -fsS -X POST http://localhost:3100/v1/auth/login \
    -H 'Content-Type: application/json' --data-binary @- | jq -er '.accessToken')
unset PASSWORD

curl -X POST http://localhost:3100/v1/runs \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"limit","limit":10,"dryRun":true}'
# unset ACCESS_TOKEN when finished.
```

Run all affiliations normally:

```sh
curl -X POST http://localhost:3100/v1/runs \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"all","dryRun":false}'
```

Schedule one run each day at 06:30 Berlin time:

```sh
curl -X PUT http://localhost:3100/v1/schedule \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled":true,
    "time":"06:30",
    "timezone":"Europe/Berlin",
    "scope":"all",
    "limit":null,
    "dryRun":false
  }'
```

The local scheduler stores the last local date it triggered, so polling cannot start the same schedule twice in one day. In AWS, the local timer is disabled and EventBridge Scheduler is authoritative. Authenticated `PUT /v1/schedule` requests update the real EventBridge expression, timezone, enabled state, and queued run request, then persist the displayed configuration in DynamoDB. The workflow also uses a repository-backed lock and rejects a second run while another run is active.

## Dashboard

**Heimdall Cost Center Reports** is the separate Next.js operator dashboard in
`frontend-vis`. Its server authenticates to this API; AWS credentials and the
Slack webhook are not needed in the browser or frontend configuration.

The dashboard edits the daily schedule and polls run and delivery history every
15 seconds. Activity, Runs and Slack deliveries have local search, status and
rolling time filters. Filtering and pagination cover only the loaded history
(up to 20 runs and 200 notification records), not every record in DynamoDB.
Message previews are read-only; a sent record means the webhook was accepted,
not that the owner read it. No new API endpoints are needed for these UI features.

## Storage and notification cadence

The default repository stores data atomically in `.data/workflow-store.json` with file permissions set to owner-only. It contains:

- workflow runs and full per-affiliation results;
- prepared owner notification records;
- notification `nextEligibleAt` timestamps;
- the daily schedule and last triggered date.

An invalid Cost ID can notify a given owner once, then remains on cooldown for seven days even though validation continues daily. When Slack delivery is enabled, the workflow posts through a private-channel incoming webhook and starts the cooldown only after Slack accepts the message. Failed deliveries are recorded and remain eligible for retry. Dry runs never call Slack.

Slack delivery is channel-only. Every alert identifies the affected owner; an affiliation without an owner is still posted as `Not assigned` and uses a Cost-ID-based cooldown.

Test the same webhook without running budget validation:

```sh
curl -X POST "$API_URL/v1/notifications/test" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Backend webhook check"}'
```

For AWS deployment, put a newly rotated webhook in this repository's uncommitted `.env` file and deploy normally:

```dotenv
SLACK_NOTIFICATIONS_ENABLED=true
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/REPLACE_WITH_ROTATED_WEBHOOK
```

The deployment script writes the URL to `/budget-validation/<environment>/SLACK_WEBHOOK_URL` as an SSM `SecureString`. The API Lambda uses it for authenticated test messages; the workflow Lambda uses it for budget notifications.

Local development uses atomic JSON repositories. AWS uses the included DynamoDB repository for runs, individual run results, notifications, schedules, authentication sessions, login throttles, and the distributed workflow lock.

Authentication is self-managed rather than Cognito. It supports Argon2id credentials, signed access tokens, rotating refresh tokens, replay detection, server-side revocation, idle/absolute expiry, login throttling, and `viewer`/`operator`/`admin` roles.

## Operational safeguards

- Productive calls are filtered by Cost ID and responses are verified locally against that Cost ID.
- Duplicate Heimdall Cost IDs cause only one Productive lookup per run.
- Productive requests have global start-rate spacing, bounded concurrency, timeouts, transient retries, and `Retry-After` handling.
- Microsoft Graph access tokens are cached and paginated links are restricted to the configured Graph origin.
- Heimdall updates re-read the exact list item and verify its Cost ID before patching.
- Updates happen only for a changed `valid` or `invalid` decision; `unknown` never clears or overwrites status.
- Run history is saved throughout processing, not only at the end.
- Manual runs return immediately and are polled through `GET /v1/runs/:runId`.
- Known credential fields, authorization/cookie headers and token fields are
  redacted from structured application logs. Review new log statements and
  exception text; redaction is not a universal secret detector.
- Slack uses an SSM `SecureString` webhook. CDK grants the API and workflow
  Lambdas read access to it; AWS administrators or other explicitly permitted
  identities can also read it. App ID, OAuth client credentials and verification
  tokens are not required for incoming-webhook messages. DMs are not implemented.

## Quality commands

```sh
npm run typecheck
npm run lint
npm test
npm run build
# or all of them:
npm run check
```

The production AWS deployment is defined with TypeScript CDK in [infra/README.md](infra/README.md). Use the concise [deployment runbook](docs/deployment.md) for normal releases. It uses API Gateway, separate API and workflow Lambdas, SQS with a dead-letter queue, DynamoDB, EventBridge Scheduler, SSM `SecureString` parameters, the AWS-managed SSM KMS key, CloudWatch, and SNS alarms. There is no ECS/Fargate service, VPC/NAT gateway, load balancer, Secrets Manager, or Cognito.

For a normal release, run `npm run check`, inspect `npm run aws:diff:code`, then
run `npm run aws:deploy:code` with the correct AWS SSO profile and region. This
preserves existing stack parameters and leaves SSM secret values untouched.
Check the actual EventBridge schedule before and after infrastructure changes;
dashboard changes can differ from CloudFormation's original parameter values.
The Next.js frontend is built and hosted separately.
Frontend-only or documentation-only changes do not need an AWS stack update.
If the reviewed CDK diff is empty, leave the running stack unchanged. A Git push
publishes source code; it does not itself deploy either application.
