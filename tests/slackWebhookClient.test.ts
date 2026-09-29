import { describe, expect, it, vi } from "vitest";

import { SlackWebhookClient } from "../src/clients/slackWebhookClient.js";

function client(fetchImpl: typeof fetch, webhookUrl = "https://hooks.slack.com/services/T000/B000/secret") {
  return new SlackWebhookClient({
    webhookUrl,
    timeoutMs: 1_000,
    maxRetries: 0,
    retryBaseMs: 1,
    fetchImpl,
  });
}

describe("SlackWebhookClient", () => {
  it("posts a text notification to the configured incoming webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    await expect(client(fetchMock).publish({ text: "Budget validation requires attention" })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL("https://hooks.slack.com/services/T000/B000/secret"));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ text: "Budget validation requires attention" });
  });

  it("rejects non-Slack webhook destinations", () => {
    expect(() => client(vi.fn(), "https://example.com/services/T000/B000/secret")).toThrow(
      "SLACK_WEBHOOK_URL must be an HTTPS hooks.slack.com/services URL",
    );
  });

  it("reports a rejected Slack delivery without exposing the webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("invalid_payload", { status: 400 }));

    await expect(client(fetchMock).publish({ text: "message" })).rejects.toThrow(
      "Slack webhook rejected the notification (400): invalid_payload",
    );
  });
});
