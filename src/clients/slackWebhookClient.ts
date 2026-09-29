import { fetchWithRetry, safeUpstreamMessage, UpstreamError } from "../utils/upstream.js";

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
}

export type SlackBlock =
  | { type: "header"; text: SlackTextObject }
  | { type: "section"; text?: SlackTextObject; fields?: SlackTextObject[] }
  | { type: "context"; elements: SlackTextObject[] }
  | { type: "divider" };

export interface SlackWebhookMessage {
  text: string;
  blocks?: SlackBlock[];
}

export interface NotificationPublisher {
  publish(message: SlackWebhookMessage, signal?: AbortSignal): Promise<void>;
}

export interface SlackWebhookClientConfig {
  webhookUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  fetchImpl?: typeof fetch;
}

function validatedWebhookUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/")) {
    throw new Error("SLACK_WEBHOOK_URL must be an HTTPS hooks.slack.com/services URL.");
  }
  return url;
}

export class SlackWebhookClient implements NotificationPublisher {
  private readonly webhookUrl: URL;

  constructor(private readonly config: SlackWebhookClientConfig) {
    this.webhookUrl = validatedWebhookUrl(config.webhookUrl);
  }

  async publish(message: SlackWebhookMessage, signal?: AbortSignal): Promise<void> {
    const response = await fetchWithRetry(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    }, {
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      retryBaseMs: this.config.retryBaseMs,
      ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
    });
    const body = await response.text();
    if (!response.ok || body.trim() !== "ok") {
      throw new UpstreamError(
        `Slack webhook rejected the notification (${response.status}): ${safeUpstreamMessage(body) || "empty response"}`,
        response.status,
      );
    }
  }
}
