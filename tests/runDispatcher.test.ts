import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowQueueMessage } from "../src/domain/workflowRequest.js";
import { MemoryWorkflowRepository } from "../src/repositories/memoryWorkflowRepository.js";
import { NotificationService } from "../src/services/notificationService.js";
import { SqsRunDispatcher } from "../src/services/runDispatcher.js";
import { WorkflowService } from "../src/services/workflowService.js";

const sqs = mockClient(SQSClient);

afterEach(() => sqs.reset());

async function fixture() {
  const repository = new MemoryWorkflowRepository();
  await repository.initialize();
  const workflow = new WorkflowService(
    { findBudgetsByCostId: async () => [] },
    { listAffiliations: async () => [], updateValidity: async () => {} },
    new NotificationService(repository, 7 * 86_400_000),
    repository,
    {
      productiveConcurrency: 1,
      timezone: "Europe/Berlin",
      uuid: () => "00000000-0000-4000-8000-000000000020",
    },
  );
  return { repository, workflow };
}

describe("SqsRunDispatcher", () => {
  it("persists the run before publishing the worker message", async () => {
    sqs.on(SendMessageCommand).resolves({ MessageId: "message-1" });
    const { workflow } = await fixture();
    const dispatcher = new SqsRunDispatcher(workflow, "https://sqs.eu-central-1.amazonaws.com/123/workflow");

    const run = await dispatcher.start({ scope: "limit", limit: 10, dryRun: true });

    expect(run.status).toBe("queued");
    const input = sqs.commandCalls(SendMessageCommand)[0]?.args[0].input;
    const message = JSON.parse(input?.MessageBody ?? "") as WorkflowQueueMessage;
    expect(message).toEqual({
      version: 1,
      runId: run.id,
      trigger: "manual",
      request: { scope: "limit", limit: 10, dryRun: true },
    });
  });

  it("marks the queued run failed and releases its lock when publishing fails", async () => {
    sqs.on(SendMessageCommand).rejects(new Error("SQS unavailable"));
    const { repository, workflow } = await fixture();
    const dispatcher = new SqsRunDispatcher(workflow, "https://sqs.eu-central-1.amazonaws.com/123/workflow");

    await expect(dispatcher.start({ scope: "all", limit: null, dryRun: true })).rejects.toThrow("SQS unavailable");

    expect(repository.runs[0]).toMatchObject({ status: "failed", error: "SQS unavailable" });
    expect(repository.runLock).toBeNull();
  });
});
