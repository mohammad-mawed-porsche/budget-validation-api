import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { AuthSession } from "../domain/auth.js";
import type { DailySchedule, NotificationRecord, RunResult, WorkflowRun } from "../domain/models.js";
import type { AuthRepository, LoginAttemptResult } from "./authRepository.js";
import type { WorkflowRepository } from "./workflowRepository.js";

interface DynamoStateRepositoryConfig {
  tableName: string;
  region: string;
  indexName?: string;
  client?: DynamoDBDocumentClient;
}

function conditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

export class DynamoStateRepository implements WorkflowRepository, AuthRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly indexName: string;
  private readonly resultCounts = new Map<string, number>();

  constructor(private readonly config: DynamoStateRepositoryConfig) {
    this.client = config.client ?? DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: config.region }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    this.indexName = config.indexName ?? "GSI1";
  }

  async initialize() {}

  private async writeBatch(requests: NonNullable<ConstructorParameters<typeof BatchWriteCommand>[0]["RequestItems"]>[string]) {
    let pending = requests;
    for (let attempt = 0; pending.length > 0 && attempt < 6; attempt += 1) {
      const response = await this.client.send(new BatchWriteCommand({
        RequestItems: { [this.config.tableName]: pending },
      }));
      pending = response.UnprocessedItems?.[this.config.tableName] ?? [];
      if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
    if (pending.length > 0) throw new Error("DynamoDB did not process all workflow result writes.");
  }

  async acquireRunLock(runId: string, expiresAt: string) {
    const nowEpoch = Math.floor(Date.now() / 1_000);
    try {
      await this.client.send(new PutCommand({
        TableName: this.config.tableName,
        Item: { PK: "LOCK#WORKFLOW", SK: "LOCK#WORKFLOW", entity: "lock", runId, expiresAt, expiresAtEpoch: Math.floor(Date.parse(expiresAt) / 1_000) },
        ConditionExpression: "attribute_not_exists(PK) OR expiresAtEpoch < :now",
        ExpressionAttributeValues: { ":now": nowEpoch },
      }));
      return { acquired: true, currentRunId: runId };
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const current = await this.client.send(new GetCommand({
        TableName: this.config.tableName,
        Key: { PK: "LOCK#WORKFLOW", SK: "LOCK#WORKFLOW" },
        ConsistentRead: true,
      }));
      return { acquired: false, currentRunId: typeof current.Item?.runId === "string" ? current.Item.runId : null };
    }
  }

  async releaseRunLock(runId: string) {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.config.tableName,
        Key: { PK: "LOCK#WORKFLOW", SK: "LOCK#WORKFLOW" },
        ConditionExpression: "runId = :runId",
        ExpressionAttributeValues: { ":runId": runId },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async saveRun(run: WorkflowRun) {
    const { results, ...metadata } = run;
    await this.client.send(new PutCommand({
      TableName: this.config.tableName,
      Item: {
        PK: `RUN#${run.id}`,
        SK: "META",
        entity: "run",
        GSI1PK: "RUN",
        GSI1SK: `${run.startedAt}#${run.id}`,
        resultCount: results.length,
        ...metadata,
      },
    }));
    const alreadySaved = this.resultCounts.get(run.id) ?? 0;
    const pending = results.slice(alreadySaved).map((result, offset) => ({ result, index: alreadySaved + offset }));
    for (const batch of chunks(pending, 25)) {
      await this.writeBatch(batch.map(({ result, index }) => ({
        PutRequest: { Item: { PK: `RUN#${run.id}`, SK: `RESULT#${String(index).padStart(8, "0")}`, entity: "run-result", result } },
      })));
    }
    this.resultCounts.set(run.id, results.length);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const items: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.config.tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `RUN#${runId}` },
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      items.push(...(response.Items ?? []));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    const meta = items.find((item) => item.SK === "META");
    if (!meta) return null;
    const results = items
      .filter((item) => typeof item.SK === "string" && item.SK.startsWith("RESULT#"))
      .map((item) => item.result as RunResult);
    const metadataKeys = new Set(["PK", "SK", "entity", "GSI1PK", "GSI1SK", "resultCount"]);
    const run = Object.fromEntries(Object.entries(meta).filter(([key]) => !metadataKeys.has(key)));
    return { ...(run as Omit<WorkflowRun, "results">), results };
  }

  async listRuns(limit: number) {
    const response = await this.client.send(new QueryCommand({
      TableName: this.config.tableName,
      IndexName: this.indexName,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "RUN" },
      ScanIndexForward: false,
      Limit: limit,
    }));
    const ids = (response.Items ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string");
    return (await Promise.all(ids.map((id) => this.getRun(id)))).filter((run): run is WorkflowRun => run !== null);
  }

  async saveNotification(notification: NotificationRecord) {
    await this.client.send(new PutCommand({
      TableName: this.config.tableName,
      Item: {
        PK: `NOTIFICATION#${notification.dedupeKey}`,
        SK: `${notification.preparedAt}#${notification.id}`,
        entity: "notification",
        GSI1PK: "NOTIFICATION",
        GSI1SK: `${notification.preparedAt}#${notification.id}`,
        notification,
      },
    }));
  }

  async getLatestNotification(dedupeKey: string): Promise<NotificationRecord | null> {
    const response = await this.client.send(new QueryCommand({
      TableName: this.config.tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `NOTIFICATION#${dedupeKey}` },
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    }));
    return response.Items?.[0]?.notification as NotificationRecord | undefined ?? null;
  }

  async listNotifications(limit: number) {
    const response = await this.client.send(new QueryCommand({
      TableName: this.config.tableName,
      IndexName: this.indexName,
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "NOTIFICATION" },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (response.Items ?? []).map((item) => item.notification as NotificationRecord);
  }

  async getSchedule(): Promise<DailySchedule | null> {
    const response = await this.client.send(new GetCommand({
      TableName: this.config.tableName,
      Key: { PK: "CONFIG", SK: "SCHEDULE" },
      ConsistentRead: true,
    }));
    return response.Item?.schedule as DailySchedule | undefined ?? null;
  }

  async saveSchedule(schedule: DailySchedule) {
    await this.client.send(new PutCommand({
      TableName: this.config.tableName,
      Item: { PK: "CONFIG", SK: "SCHEDULE", entity: "schedule", schedule },
    }));
  }

  async createSession(session: AuthSession) {
    await this.client.send(new PutCommand({
      TableName: this.config.tableName,
      Item: {
        PK: `SESSION#${session.id}`,
        SK: "META",
        entity: "auth-session",
        session,
        refreshTokenHash: session.refreshTokenHash,
        revokedAt: session.revokedAt,
        expiresAtEpoch: Math.floor(Date.parse(session.absoluteExpiresAt) / 1_000),
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }));
  }

  async getSession(sessionId: string): Promise<AuthSession | null> {
    const response = await this.client.send(new GetCommand({
      TableName: this.config.tableName,
      Key: { PK: `SESSION#${sessionId}`, SK: "META" },
      ConsistentRead: true,
    }));
    return response.Item?.session as AuthSession | undefined ?? null;
  }

  async rotateSession(sessionId: string, expectedRefreshHash: string, session: AuthSession) {
    try {
      await this.client.send(new PutCommand({
        TableName: this.config.tableName,
        Item: {
          PK: `SESSION#${session.id}`,
          SK: "META",
          entity: "auth-session",
          session,
          refreshTokenHash: session.refreshTokenHash,
          revokedAt: session.revokedAt,
          expiresAtEpoch: Math.floor(Date.parse(session.absoluteExpiresAt) / 1_000),
        },
        ConditionExpression: "refreshTokenHash = :expected AND (attribute_not_exists(revokedAt) OR revokedAt = :null)",
        ExpressionAttributeValues: { ":expected": expectedRefreshHash, ":null": null },
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async revokeSession(sessionId: string, revokedAt: string) {
    try {
      const current = await this.getSession(sessionId);
      if (!current) return;
      await this.client.send(new UpdateCommand({
        TableName: this.config.tableName,
        Key: { PK: `SESSION#${sessionId}`, SK: "META" },
        UpdateExpression: "SET revokedAt = :revokedAt, #session = :session",
        ExpressionAttributeNames: { "#session": "session" },
        ExpressionAttributeValues: { ":revokedAt": revokedAt, ":session": { ...current, revokedAt } },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }

  async consumeLoginAttempt(key: string, maxAttempts: number, windowSeconds: number, now: Date): Promise<LoginAttemptResult> {
    const pk = `LOGIN#${key}`;
    const nowEpoch = Math.floor(now.getTime() / 1_000);
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        const active = await this.client.send(new UpdateCommand({
          TableName: this.config.tableName,
          Key: { PK: pk, SK: "ATTEMPT" },
          UpdateExpression: "ADD attemptCount :one",
          ConditionExpression: "windowExpiresAtEpoch > :now",
          ExpressionAttributeValues: { ":one": 1, ":now": nowEpoch },
          ReturnValues: "ALL_NEW",
        }));
        const count = Number(active.Attributes?.attemptCount ?? 1);
        const expires = Number(active.Attributes?.windowExpiresAtEpoch ?? nowEpoch + windowSeconds);
        return { allowed: count <= maxAttempts, retryAfterSeconds: Math.max(1, expires - nowEpoch) };
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
      }
      try {
        const expires = nowEpoch + windowSeconds;
        await this.client.send(new PutCommand({
          TableName: this.config.tableName,
          Item: { PK: pk, SK: "ATTEMPT", entity: "login-attempt", attemptCount: 1, windowExpiresAtEpoch: expires, expiresAtEpoch: expires },
          ConditionExpression: "attribute_not_exists(PK) OR windowExpiresAtEpoch <= :now",
          ExpressionAttributeValues: { ":now": nowEpoch },
        }));
        return { allowed: true, retryAfterSeconds: windowSeconds };
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
      }
    }
    return { allowed: false, retryAfterSeconds: windowSeconds };
  }

  async clearLoginAttempts(key: string) {
    await this.client.send(new DeleteCommand({
      TableName: this.config.tableName,
      Key: { PK: `LOGIN#${key}`, SK: "ATTEMPT" },
    }));
  }
}
