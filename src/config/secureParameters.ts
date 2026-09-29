export const SECURE_PARAMETER_GROUPS = {
  api: ["AUTH_SESSION_SECRET", "AUTH_USERS_JSON"],
  workflow: ["MICROSOFT_CLIENT_SECRET", "PRODUCTIVE_API_KEY"],
  all: ["AUTH_SESSION_SECRET", "AUTH_USERS_JSON", "MICROSOFT_CLIENT_SECRET", "PRODUCTIVE_API_KEY"],
} as const;

export const OPTIONAL_SECURE_PARAMETER_GROUPS = {
  api: ["SLACK_WEBHOOK_URL"],
  workflow: ["SLACK_WEBHOOK_URL"],
  all: ["SLACK_WEBHOOK_URL"],
} as const satisfies Record<keyof typeof SECURE_PARAMETER_GROUPS, readonly string[]>;

export type SecureParameterGroup = keyof typeof SECURE_PARAMETER_GROUPS;
