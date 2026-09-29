import {
  GetScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";

import type { WorkflowQueueMessage } from "../domain/workflowRequest.js";
import type { ScheduleUpdate, ScheduleController } from "./scheduleService.js";

export class EventBridgeScheduleController implements ScheduleController {
  private readonly client: SchedulerClient;

  constructor(
    private readonly scheduleName: string,
    region?: string,
    client?: SchedulerClient,
  ) {
    this.client = client ?? new SchedulerClient(region ? { region } : {});
  }

  async update(input: ScheduleUpdate): Promise<void> {
    const existing = await this.client.send(new GetScheduleCommand({ Name: this.scheduleName }));
    if (!existing.Target?.Arn || !existing.Target.RoleArn) {
      throw new Error(`EventBridge schedule ${this.scheduleName} has no usable target.`);
    }

    const [hour, minute] = input.time.split(":");
    const message: WorkflowQueueMessage = {
      version: 1,
      trigger: "schedule",
      request: {
        scope: input.scope,
        limit: input.scope === "limit" ? input.limit : null,
        dryRun: input.dryRun,
      },
    };
    await this.client.send(new UpdateScheduleCommand({
      Name: this.scheduleName,
      ...(existing.GroupName ? { GroupName: existing.GroupName } : {}),
      ScheduleExpression: `cron(${minute} ${hour} * * ? *)`,
      ScheduleExpressionTimezone: input.timezone,
      State: input.enabled ? "ENABLED" : "DISABLED",
      FlexibleTimeWindow: existing.FlexibleTimeWindow ?? { Mode: "OFF" },
      Target: {
        ...existing.Target,
        Input: JSON.stringify(message),
      },
      ...(existing.Description ? { Description: existing.Description } : {}),
      ...(existing.StartDate ? { StartDate: existing.StartDate } : {}),
      ...(existing.EndDate ? { EndDate: existing.EndDate } : {}),
      ...(existing.KmsKeyArn ? { KmsKeyArn: existing.KmsKeyArn } : {}),
      ...(existing.ActionAfterCompletion ? { ActionAfterCompletion: existing.ActionAfterCompletion } : {}),
    }));
  }
}
