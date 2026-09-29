import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/utils/upstream.js";

describe("credentialed upstream requests", () => {
  it("rejects redirects rather than forwarding credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    await fetchWithRetry("https://upstream.example", {
      method: "POST", headers: { authorization: "Bearer test-only" }, body: "test", redirect: "follow",
    }, { timeoutMs: 1000, maxRetries: 0, retryBaseMs: 1, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("https://upstream.example", expect.objectContaining({ redirect: "error" }));
  });
});
