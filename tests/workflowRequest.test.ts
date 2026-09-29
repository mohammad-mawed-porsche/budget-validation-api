import { describe, expect, it } from "vitest";

import { workflowQueueMessageSchema } from "../src/domain/workflowRequest.js";

describe("workflowQueueMessageSchema", () => {
  it("accepts the shared API and worker queue contract", () => {
    expect(workflowQueueMessageSchema.parse({
      version: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      trigger: "manual",
      request: { scope: "limit", limit: 10, dryRun: true },
    })).toMatchObject({ trigger: "manual", request: { limit: 10 } });
  });

  it("rejects invalid limited runs and unknown message fields", () => {
    expect(workflowQueueMessageSchema.safeParse({
      version: 1,
      trigger: "schedule",
      request: { scope: "limit", limit: null, dryRun: false },
    }).success).toBe(false);
    expect(workflowQueueMessageSchema.safeParse({
      version: 1,
      trigger: "schedule",
      request: { scope: "all", limit: null, dryRun: false },
      unexpected: true,
    }).success).toBe(false);
  });
});

