# Deployment

The production service is deployed by AWS CDK as the `BudgetValidationStack` CloudFormation stack in `eu-central-1`. It runs as two Node.js Lambdas: one serves the Fastify API and one executes queued validation runs.

## Normal code deployment

Use this path for application, Slack workflow, or CDK changes. It preserves the stack's current CloudFormation parameters and does not read or overwrite any SSM secret value.

```sh
export AWS_PROFILE=PDCP-AccountDeveloper-627588894768
export AWS_REGION=eu-central-1
aws sso login
aws sts get-caller-identity

npm ci
npm ci --prefix infra
npm run check
npm run aws:diff:code
npm run aws:deploy:code
```

If Slack support is being introduced to a stack that does not have the `SlackNotificationsEnabled` parameter yet, set it explicitly for that first update:

```sh
SLACK_NOTIFICATIONS_ENABLED=true npm run aws:diff:code
SLACK_NOTIFICATIONS_ENABLED=true npm run aws:deploy:code
```

Later code deployments read and preserve the deployed `true` value automatically.

The deployment command performs these steps:

1. Confirms that `BudgetValidationStack` exists and reads its parameter metadata.
2. Runs TypeScript checks, infrastructure tests, Lambda packaging, and `cdk synth`.
3. Deploys with CDK's `--previous-parameters` behavior, preserving existing stack values.
4. Lets CloudFormation update the Lambda code and any changed AWS resources.

The generated Lambda artifact is stored in `.lambda/`. It includes production dependencies and the Linux x64 Argon2 binary, so the Lambda console may not be able to display the bundled file. Source changes should be made and deployed from this repository, not edited in the AWS console.

Before deploying, record the actual EventBridge schedule state, expression,
timezone and target input in the AWS console. Dashboard schedule edits update
the resource directly, not CloudFormation's saved parameters. A Lambda-code-only
diff should leave it alone; an infrastructure change to the schedule can reapply
the stack values. Verify the actual schedule again afterward. Do not enable it
or switch dry-run mode merely to verify a release.

Commit reviewed changes in both repositories before the release. The frontend
is a separate Next.js application; this CDK stack does not host or deploy it.
See its README for the frontend build and hosting requirements.

## Configuration and secret deployment

The normal code deployment deliberately leaves Parameter Store untouched. Production secrets are stored as encrypted `SecureString` values under:

```text
/budget-validation/production/
```

This includes `AUTH_SESSION_SECRET`, `AUTH_USERS_JSON`, `MICROSOFT_CLIENT_SECRET`, `PRODUCTIVE_API_KEY`, and `SLACK_WEBHOOK_URL`.

Use `npm run aws:deploy` only when the local `.env` is intentionally the source of truth for every value. That command overwrites the production SecureStrings before deploying and forces the daily schedule to `DISABLED`:

```sh
export AWS_PROFILE=PDCP-AccountDeveloper-627588894768
aws sso login
npm run aws:deploy
```

Do not use the full configuration deployment merely to publish code. A stale local Productive key, Slack webhook, password hash, or Microsoft secret would replace the working AWS value.

To change one secret, open AWS Systems Manager → Parameter Store in the correct
account and region. Select only the relevant `/budget-validation/production/…`
entry, choose Edit, enter the new value and preserve its SecureString type/key.
For `AUTH_USERS_JSON`, replace only the affected user's hash and preserve other
users/roles. Do not replace the JSON document with a plaintext password.
Avoid putting secret values in shell command arguments, logs or screenshots.

Warm Lambda instances cache parameters. After rotation, make an actual code or
configuration update to the affected Lambda so replacement environments load
the new value. Re-running deployment with an unchanged asset is a no-op and
does **not** reliably refresh cached parameters. Do not edit secrets into Lambda
environment variables to bypass Parameter Store. Update dependent frontend
credentials too; see [SECURITY.md](../SECURITY.md) for session invalidation.

### API account username changes

Parameter Store's `/budget-validation/production/AUTH_USERS_JSON` is the source
of truth for production API usernames; they are not hard-coded in application
code or this runbook. The dashboard's server-side `BUDGET_VALIDATION_API_USERNAME`
and `BUDGET_VALIDATION_API_PASSWORD` must identify the same enabled AWS account.
Neither a Git push nor changing those frontend variables updates `AUTH_USERS_JSON`.

For an explicitly approved rename, change only the selected user's `username`
in `/budget-validation/production/AUTH_USERS_JSON`. Preserve that user's
existing `passwordHash`, `roles` and `disabled` value, every other user, and the
parameter's SecureString type and encryption key. Do not add a second account
or an old-name fallback. A username rename preserves the existing password; it
does not rotate a password that has been exposed.

Refresh only the API Lambda's warm environments after updating the parameter.
Use the reviewed CDK path with a new non-secret revision marker:

```sh
npm run aws:diff:code
AUTH_CONFIG_VERSION=ssm-auth-users-v5 npm run aws:deploy:code
```

`AuthConfigurationVersion` is a CloudFormation parameter exposed to the API
Lambda as `AUTH_CONFIG_VERSION`. It exists only to replace warm environments;
the username, hash and roles still come from encrypted Parameter Store and are
never placed in CDK context, source, Lambda environment variables, stack
parameters or outputs. The deployment preserves all existing CloudFormation
parameters. CDK's `diff` command shows the new parameter wiring but does not
accept a parameter override; the reviewed value is supplied only to `deploy`.
Wait for `UPDATE_COMPLETE` before verifying the new account. Do not alter the
workflow Lambda, schedule, integration secrets or signing keys for a
username-only rename.

After the new configuration is loaded, access and refresh tokens for the old
username are rejected because that account no longer exists. Historical auth
records are not deleted, and dashboard cookies use a separate signing key;
sign out and sign back in to verify the new account. Update the frontend
username if needed and redeploy it so its runtime reads the new configuration.
Check sign-in and read-only schedule/history requests without starting a run
or sending a Slack test message.

## Verification

CDK prints the API URL after deployment. Verify the public endpoints first:

```sh
API_URL=https://2cve21ofa8.execute-api.eu-central-1.amazonaws.com
curl -fsS "$API_URL/health" | jq
curl -fsS "$API_URL/ready" | jq
```

Then log in and start a single-item dry run. A dry run reads Productive and Heimdall but does not update Heimdall or send Slack notifications:

```zsh
read "API_USERNAME?Configured API username: "
read -s "PASSWORD?API account password: "; echo
TOKEN=$(printf '%s' "$PASSWORD" | jq -Rs --arg username "$API_USERNAME" '{username:$username,password:.}' | \
  curl -fsS -X POST "$API_URL/v1/auth/login" \
    -H 'Content-Type: application/json' --data-binary @- | \
  jq -er '.accessToken')

START=$(curl -fsS -X POST "$API_URL/v1/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"limit","limit":1,"dryRun":true}')
echo "$START" | jq

RUN_ID=$(echo "$START" | jq -r '.runId')
curl -fsS "$API_URL/v1/runs/$RUN_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
unset API_USERNAME PASSWORD TOKEN
```

Use a non-dry run only after inspecting the dry-run result. A live run can update Heimdall and send an invalid-budget message to the configured private Slack channel.

## Rollback and operations

CloudFormation rolls back a failed update automatically. Lambda logs, API access logs, alarms, and the operations dashboard are in CloudWatch. Failed workflow messages are retried through SQS and moved to the dead-letter queue after three receives. DynamoDB uses deletion protection, point-in-time recovery, and a retain policy; CDK stack updates do not delete run or notification history.

For a runtime regression after a successful stack update, revert the offending
commit, run the checks and CDK diff, then deploy that reviewed code with the same
code-only command. A stack update succeeding does not prove that integrations
work. `/health` and `/ready` are process checks only; a dry run needs a separate,
deliberate operator action. Never use a live run or Slack test as an automatic
deployment smoke test.

Subscribe an operator to the alarm SNS topic and confirm the subscription.
The CDK stack creates the topic and alarms but does not choose recipients.
