import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { BudgetValidationStack } from "../lib/budget-validation-stack.js";

describe("BudgetValidationStack", () => {
  const app = new cdk.App();
  const template = Template.fromStack(new BudgetValidationStack(app, "TestStack", {
    env: { account: "111111111111", region: "eu-central-1" },
  }));

  it("creates durable encrypted state with point-in-time recovery", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
      TimeToLiveSpecification: { AttributeName: "expiresAtEpoch", Enabled: true },
    });
  });

  it("runs the API and workflow on Lambda behind an HTTP API", () => {
    template.resourceCountIs("AWS::Lambda::Function", 2);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "api.handler",
      Runtime: "nodejs22.x",
      Timeout: 29,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "workflow.handler",
      Runtime: "nodejs22.x",
      Timeout: 900,
      ReservedConcurrentExecutions: 1,
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
      DefaultRouteSettings: {
        DetailedMetricsEnabled: true,
        ThrottlingBurstLimit: 100,
        ThrottlingRateLimit: 50,
      },
    });
    template.resourceCountIs("AWS::ECS::Service", 0);
    template.resourceCountIs("AWS::EC2::VPC", 0);
  });

  it("queues manual and scheduled runs with retry isolation", () => {
    template.resourceCountIs("AWS::SQS::Queue", 2);
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: { Ref: "DailyScheduleExpression" },
      ScheduleExpressionTimezone: { Ref: "DailyScheduleTimezone" },
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: Match.objectLike({ Input: Match.stringLikeRegexp('"trigger":"schedule"') }),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "api.handler",
      Environment: {
        Variables: Match.objectLike({ EVENTBRIDGE_SCHEDULE_NAME: { Ref: Match.anyValue() } }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["scheduler:GetSchedule", "scheduler:UpdateSchedule"],
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  it("reads SSM SecureStrings and does not create Secrets Manager secrets", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "ssm:GetParameters", Effect: "Allow" }),
          Match.objectLike({ Action: "kms:Decrypt", Effect: "Allow" }),
        ]),
      },
    });
  });

  it("keeps Slack disabled by default and configures both notification entrypoints together", () => {
    template.hasParameter("SlackNotificationsEnabled", {
      Type: "String",
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "api.handler",
      Environment: {
        Variables: Match.objectLike({ SLACK_NOTIFICATIONS_ENABLED: { Ref: "SlackNotificationsEnabled" } }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "workflow.handler",
      Environment: {
        Variables: Match.objectLike({ SLACK_NOTIFICATIONS_ENABLED: { Ref: "SlackNotificationsEnabled" } }),
      },
    });
  });
});
