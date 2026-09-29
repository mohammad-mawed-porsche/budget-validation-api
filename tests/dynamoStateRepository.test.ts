import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowRun } from "../src/domain/models.js";
import { DynamoStateRepository } from "../src/repositories/dynamoStateRepository.js";

const dynamo = mockClient(DynamoDBDocumentClient);
afterEach(() => dynamo.reset());

function run(): WorkflowRun {
  return {
    id: "run-1",
    trigger: "manual",
    status: "completed",
    dryRun: true,
    scope: "all",
    limit: null,
    startedAt: "2026-09-16T08:00:00.000Z",
    finishedAt: "2026-09-16T08:00:01.000Z",
    summary: { selected: 1, processed: 1, valid: 0, invalid: 0, unknown: 1, heimdallUpdated: 0, notificationsPrepared: 0, errors: 0 },
    results: [{
      itemId: "item-1",
      costId: "COST-1",
      normalizedCostId: "COST-1",
      affiliation: { category: "Team", title: "Platform", index: 1 },
      owner: { objectId: "owner-1", emails: ["owner@example.test"] },
      previousValid: null,
      decision: "unknown",
      reason: "productive-budget-missing",
      matchedBudget: null,
      candidateBudgetIds: [],
      checks: [],
      heimdallUpdated: false,
      notification: "not-required",
      error: null,
    }],
    error: null,
  };
}

describe("DynamoStateRepository", () => {
  it("stores run metadata separately from results to stay below DynamoDB item limits", async () => {
    dynamo.on(PutCommand).resolves({});
    dynamo.on(BatchWriteCommand).resolves({});
    const repository = new DynamoStateRepository({ tableName: "state", region: "eu-central-1" });
    await repository.saveRun(run());

    const metadata = dynamo.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(metadata).toMatchObject({ PK: "RUN#run-1", SK: "META", resultCount: 1 });
    expect(metadata).not.toHaveProperty("results");
    const resultWrites = dynamo.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.state;
    expect(resultWrites?.[0]?.PutRequest?.Item).toMatchObject({ PK: "RUN#run-1", SK: "RESULT#00000000" });
  });

  it("reassembles a run from metadata and separately stored result records", async () => {
    const value = run();
    const { results, ...metadata } = value;
    dynamo.on(QueryCommand).resolves({ Items: [
      { PK: "RUN#run-1", SK: "META", entity: "run", GSI1PK: "RUN", GSI1SK: "date", resultCount: 1, ...metadata },
      { PK: "RUN#run-1", SK: "RESULT#00000000", result: results[0] },
    ] });
    const repository = new DynamoStateRepository({ tableName: "state", region: "eu-central-1" });
    await expect(repository.getRun("run-1")).resolves.toEqual(value);
  });
});
