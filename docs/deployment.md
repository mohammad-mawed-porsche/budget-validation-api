# Deployment

The production service is deployed by AWS CDK as the `BudgetValidationStack` CloudFormation stack in `eu-central-1`. It runs as two Node.js Lambdas: one serves the Fastify API and one executes queued validation runs.

## Normal code deployment

Use this path for application, Slack workflow, or CDK changes. It preserves the stack's current CloudFormation parameters and does not read or overwrite any SSM secret value.

```sh
export AWS_PROFILE=PDCP-AccountDeveloper-627588894768
aws sso login

npm install
npm install --prefix infra
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
3. Deploys with CDK's `--previous-parameters` behavior, preserving existing values.
4. Lets CloudFormation update the Lambda code and any changed AWS resources.

The generated Lambda artifact is stored in `.lambda/`. It includes production dependencies and the Linux x64 Argon2 binary, so the Lambda console may not be able to display the bundled file. Source changes should be made and deployed from this repository, not edited in the AWS console.

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

To update one secret safely, change only that Parameter Store entry. For example:

```sh
read -s "PRODUCTIVE_API_KEY?Productive API key: "; echo
aws ssm put-parameter \
  --name /budget-validation/production/PRODUCTIVE_API_KEY \
  --type SecureString \
  --value "$PRODUCTIVE_API_KEY" \
  --overwrite
unset PRODUCTIVE_API_KEY
```

Warm Lambda instances cache parameters. After a secret rotation, publish the code again with `npm run aws:deploy:code`, or update the affected Lambda configuration, so new instances load the new value immediately.

## Verification

CDK prints the API URL after deployment. Verify the public endpoints first:

```sh
API_URL=https://2cve21ofa8.execute-api.eu-central-1.amazonaws.com
curl -fsS "$API_URL/health" | jq
curl -fsS "$API_URL/ready" | jq
```

Then log in and start a single-item dry run. A dry run reads Productive and Heimdall but does not update Heimdall or send Slack notifications:

```sh
read -s "PASSWORD?Admin password: "; echo
TOKEN=$(jq -nc --arg username admin --arg password "$PASSWORD" \
  '{username:$username,password:$password}' | \
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
unset PASSWORD TOKEN
```

Use a non-dry run only after inspecting the dry-run result. A live run can update Heimdall and send an invalid-budget message to the configured private Slack channel.

## Rollback and operations

CloudFormation rolls back a failed update automatically. Lambda logs, API access logs, alarms, and the operations dashboard are in CloudWatch. Failed workflow messages are retried through SQS and moved to the dead-letter queue after three receives. DynamoDB uses deletion protection, point-in-time recovery, and a retain policy; CDK stack updates do not delete run or notification history.
