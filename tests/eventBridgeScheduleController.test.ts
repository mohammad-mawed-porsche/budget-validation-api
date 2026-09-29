import {
  GetScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { EventBridgeScheduleController } from "../src/services/eventBridgeScheduleController.js";

const scheduler = mockClient(SchedulerClient);

describe("EventBridgeScheduleController", () => {
  beforeEach(() => scheduler.reset());

  it("updates the AWS schedule and its queued workflow request", async () => {
    scheduler.on(GetScheduleCommand).resolves({
      Name: "daily-budget-validation",
      GroupName: "default",
      ScheduleExpression: "cron(0 6 * * ? *)",
      ScheduleExpressionTimezone: "Europe/Berlin",
      State: "DISABLED",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: "arn:aws:sqs:eu-central-1:111111111111:workflow",
        RoleArn: "arn:aws:iam::111111111111:role/scheduler",
        DeadLetterConfig: { Arn: "arn:aws:sqs:eu-central-1:111111111111:dlq" },
      },
    });
    scheduler.on(UpdateScheduleCommand).resolves({ ScheduleArn: "arn:aws:scheduler:::schedule/default/daily-budget-validation" });

    await new EventBridgeScheduleController("daily-budget-validation", "eu-central-1").update({
      enabled: true,
      time: "07:45",
      timezone: "Europe/Berlin",
      scope: "limit",
      limit: 25,
      dryRun: true,
    });

    expect(scheduler.commandCalls(UpdateScheduleCommand)[0]?.args[0].input).toMatchObject({
      Name: "daily-budget-validation",
      GroupName: "default",
      ScheduleExpression: "cron(45 07 * * ? *)",
      ScheduleExpressionTimezone: "Europe/Berlin",
      State: "ENABLED",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: "arn:aws:sqs:eu-central-1:111111111111:workflow",
        RoleArn: "arn:aws:iam::111111111111:role/scheduler",
        Input: JSON.stringify({
          version: 1,
          trigger: "schedule",
          request: { scope: "limit", limit: 25, dryRun: true },
        }),
      },
    });
  });

  it("refuses to overwrite a schedule without a complete target", async () => {
    scheduler.on(GetScheduleCommand).resolves({ Target: { Arn: "arn:aws:sqs:::workflow", RoleArn: undefined } });

    await expect(new EventBridgeScheduleController("broken", "eu-central-1").update({
      enabled: false,
      time: "06:00",
      timezone: "Europe/Berlin",
      scope: "all",
      limit: null,
      dryRun: false,
    })).rejects.toThrow("has no usable target");
    expect(scheduler.commandCalls(UpdateScheduleCommand)).toHaveLength(0);
  });
});
