# API security

Reviewed 29 September 2026. Scope: repository code, dependencies, synthesized
CDK resources and selected read-only production metadata. This is not a full
AWS account audit or a penetration-test certification.

## Authentication and permissions

The deployed API uses self-managed local users, **not Cognito or AWS SSO**.
AWS SSO authenticates developers to deploy infrastructure; it does not log end
users into the application.

1. `POST /v1/auth/login` verifies an Argon2id hash from `AUTH_USERS_JSON`.
   The password hash helper uses 64 MiB, three iterations and one lane. Existing
   hashes retain their encoded settings. Passwords are not stored in DynamoDB.
2. Login creates a session and returns a signed HS256 JWT. Default access
   lifetime is 15 minutes. Validation checks signature, fixed algorithm, issuer,
   audience, expiry, and the corresponding DynamoDB session on every request.
3. Sessions have a 30-minute idle limit, renewed by refresh, and a 12-hour
   absolute limit. Expiry is enforced by application code; DynamoDB TTL cleanup
   may happen later. Access requests alone do not renew idle expiry.
4. Refresh tokens contain a random 256-bit secret and a domain-separated HMAC.
   Only their SHA-256 hash is stored. The cookie is HttpOnly, Secure in the CDK
   deployment, SameSite=Strict, and scoped to `/v1/auth`. Refresh rotates it
   using a conditional write. Reusing an authentic old signed token revokes the
   session. Arbitrary tokens containing someone else's session ID cannot do so.
   A current legacy two-part refresh token is accepted once for migration;
   later reuse is rejected without replay revocation because its authenticity
   can no longer be established.
5. Logout requires possession of the current refresh token or a valid access
   token before revoking a session. Session revocation invalidates associated
   access tokens on subsequent checks. Refresh also checks the user-agent hash;
   this is an extra signal, not device binding or MFA.
6. Removed/disabled users and role changes invalidate existing sessions once
   the running service has loaded the new user configuration. SSM is cached for
   a Lambda environment's lifetime, so replace warm environments after changes.

| Role | Permitted operations |
| --- | --- |
| viewer | Read runs, results, notifications, schedule and own identity |
| operator | Viewer access plus start runs and send channel test messages |
| admin | All of the above plus change the daily schedule |

The dashboard uses one server-side API account. API logs therefore identify
that account, not separate dashboard operators. `static-token` mode is a local
compatibility option with all roles and no automatic expiry; do not substitute
it for production local-user authentication. The private worker uses a dummy
static token internally but has no public HTTP trigger.

## Request boundaries

- Fastify limits request bodies to 16 KiB and validates mutation payloads with
  Zod. `/v1/*` responses use `Cache-Control: no-store`; Helmet adds HTTP headers.
- DynamoDB-backed login throttling defaults to five attempts per normalized
  username/IP combination in 15 minutes. API Gateway also limits traffic to
  50 requests/second with burst 100. These are not comprehensive DoS protection
  and do not prevent distributed password guessing.
- The Lambda adapter takes the client IP from API Gateway request context.
  Fastify ignores client-supplied forwarded headers in the Lambda entrypoint.
  A standalone server must use `TRUST_PROXY` only behind a trusted ingress.
- CORS is an allowed-browser-origin policy, not authentication or a firewall.
  The HTTP API is internet-reachable; its Lambda enforces bearer authentication.
  `/health`, `/ready`, login, refresh and logout are public entrypoints with their
  own credential/session handling. Health endpoints are not integration checks.
- Credentialed integration requests reject redirects rather than forwarding
  API keys or OAuth request bodies to a different destination.
- No MFA, account recovery, corporate SSO, WAF or private API endpoint is
  configured. Add company access controls before widening access.

## AWS secrets, encryption and IAM

Five SSM `SecureString` parameters live under `/budget-validation/production/`:

| Parameter | Lambda role granted access by CDK |
| --- | --- |
| AUTH_SESSION_SECRET, AUTH_USERS_JSON | API |
| PRODUCTIVE_API_KEY, MICROSOFT_CLIENT_SECRET | Worker |
| SLACK_WEBHOOK_URL | API and worker |

KMS decrypts parameters using the AWS-managed `alias/aws/ssm` key. Values are
loaded into runtime memory, not embedded into the deployment artifact or
CloudFormation parameters. CDK grants `ssm:GetParameters` on exact parameter
ARNs and `kms:Decrypt` via the regional SSM service. This is **not** an exclusive
boundary against AWS administrators or other permitted account identities.
The AWS-managed key has a policy managed by AWS; use a customer-managed key if
separate key-level access control is required. See [AWS's explanation](https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-restrict-decryption.html).

Both Lambdas have read/write access to the single state table, including auth
records; there is no per-entity IAM isolation inside it. The API can send to the
workflow queue and update the one configured schedule. Its PassRole permission
is restricted to that schedule's role and `scheduler.amazonaws.com`. Scheduler
can send messages to the workflow/dead-letter queues. Workers consume the queue.

DynamoDB encryption, point-in-time recovery, deletion protection and retention
are configured. SQS uses managed encryption and requires TLS. Lambda roles
receive short-lived AWS credentials automatically; no AWS access keys belong in
the frontend. Account-wide IAM and external Microsoft/Productive permissions
were not exhaustively audited in this review.

## Data, delivery and monitoring

Run results and notification history contain owner emails, Cost IDs and budget
data. Restrict table, dashboard, CloudWatch and private Slack channel access.
Run/notification history does not currently have a time-based deletion policy;
agree retention requirements with the data owner. Session/throttle records use TTL.

Only definitive changed results update Heimdall, after rechecking the item and
Cost ID. Unknown decisions and dry runs do not write status or send Slack.
Notification cooldowns reduce repeated alerts; they are not a delivery security
boundary. Slack's `ok` response means acceptance, not that an owner has read it.
Messages go to the configured channel, not DMs. Sending and recording a delivery
are not one transaction, so crashes/timeouts can cause uncertain or duplicate
delivery. No exactly-once guarantee is made.

Structured logs redact known credentials, auth/cookie headers and token fields.
Request bodies are not routinely logged. Exception text and future fields still
need review; do not log parameter contents. Authentication logs contain account,
session and client-address metadata. CloudWatch log retention is one month.
CDK creates error/DLQ alarms and an SNS topic, **not recipient subscriptions**.
The topic had no subscriptions in the 29 September review; an operator must add
and confirm a recipient to receive alarm notifications.

## Rotation and release

Treat any password or webhook shared in chat/screenshots as exposed. Rotate at
its source and replace the corresponding configuration. Never copy exposed
values into docs or commits. Password hashes are sensitive too.

For an API password change, update only the user's Argon2id hash in SSM, update
dependent clients, and replace warm API Lambda environments. A password change
alone does not revoke old sessions: revoke them in the auth store. Rotating
`AUTH_SESSION_SECRET` invalidates signed access/refresh tokens after reload, but
legacy unsigned refresh sessions must also be explicitly revoked for complete
invalidation. Dashboard
cookies use a different signing key and must be revoked separately.

Follow [the deployment runbook](docs/deployment.md). Use code-only deployment to
avoid overwriting production secrets with local `.env` values. An unchanged
code deployment may be a no-op and will **not** refresh cached SSM values; an
actual Lambda configuration/code change is required after rotation. Keep old
signing keys private and never restore an exposed key during rollback.

Release checks include auth/replay/role tests, production configuration guards,
request limits, CDK assertions, dependency audits and a compiled Lambda build.
The review fixed forged refresh/logout revocation, stale-role acceptance after
config reload, trusted-client-IP handling, credential redaction, no-store
responses and insecure production defaults. Automated checks do not eliminate
unknown vulnerabilities or replace periodic review.
