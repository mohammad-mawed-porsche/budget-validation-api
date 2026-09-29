import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

import { OPTIONAL_SECURE_PARAMETER_GROUPS, SECURE_PARAMETER_GROUPS } from "../../src/config/secureParameters.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(directory, "../..");
const lambdaAssetDirectory = path.join(apiDirectory, ".lambda");

export class BudgetValidationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const allowedOrigins = new cdk.CfnParameter(this, "AllowedOrigins", {
      type: "CommaDelimitedList",
      default: "https://example.com",
      description: "Browser origins allowed to call the HTTP API.",
    });
    const parameterPrefix = new cdk.CfnParameter(this, "SecureParameterPrefix", {
      type: "String",
      default: "/budget-validation/production",
      allowedPattern: "^/[A-Za-z0-9_./-]+$",
      description: "SSM path containing the required SecureString parameters.",
    });
    const productiveOrgId = new cdk.CfnParameter(this, "ProductiveOrganizationId", {
      type: "String",
      description: "Productive organization ID (not a secret).",
    });
    const microsoftTokenUrl = new cdk.CfnParameter(this, "MicrosoftTokenUrl", {
      type: "String",
      description: "Microsoft OAuth token URL including the tenant ID.",
    });
    const microsoftClientId = new cdk.CfnParameter(this, "MicrosoftClientId", {
      type: "String",
      description: "Microsoft Entra application client ID (not a secret).",
    });
    const heimdallSiteId = new cdk.CfnParameter(this, "HeimdallSiteId", {
      type: "String",
      description: "Microsoft Graph site ID for Heimdall.",
    });
    const heimdallListId = new cdk.CfnParameter(this, "HeimdallListId", {
      type: "String",
      description: "Microsoft Graph list ID for Heimdall affiliations.",
    });
    const heimdallBudgetValidTrueValue = new cdk.CfnParameter(this, "HeimdallBudgetValidTrueValue", {
      type: "String",
      default: "True",
      description: "Heimdall choice value representing a valid budget.",
    });
    const heimdallBudgetValidFalseValue = new cdk.CfnParameter(this, "HeimdallBudgetValidFalseValue", {
      type: "String",
      default: "False",
      description: "Heimdall choice value representing an invalid budget.",
    });
    const scheduleExpression = new cdk.CfnParameter(this, "DailyScheduleExpression", {
      type: "String",
      default: "cron(0 6 * * ? *)",
      description: "EventBridge Scheduler expression for the daily workflow.",
    });
    const scheduleTimezone = new cdk.CfnParameter(this, "DailyScheduleTimezone", {
      type: "String",
      default: "Europe/Berlin",
      description: "IANA timezone used by EventBridge Scheduler.",
    });
    const scheduleState = new cdk.CfnParameter(this, "DailyScheduleState", {
      type: "String",
      default: "DISABLED",
      allowedValues: ["ENABLED", "DISABLED"],
      description: "Keep disabled until all SecureString parameters are configured and a dry run has passed.",
    });
    const slackNotificationsEnabled = new cdk.CfnParameter(this, "SlackNotificationsEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Deliver confirmed invalid-budget notifications through the Slack incoming webhook stored in SSM.",
    });

    const table = new dynamodb.Table(this, "StateTable", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAtEpoch",
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const deadLetterQueue = new sqs.Queue(this, "WorkflowDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    const workflowQueue = new sqs.Queue(this, "WorkflowQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.minutes(16),
      retentionPeriod: cdk.Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    const apiLogGroup = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const workerLogGroup = new logs.LogGroup(this, "WorkerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const apiAccessLogGroup = new logs.LogGroup(this, "ApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const commonEnvironment: Record<string, string> = {
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      CORS_ORIGINS: cdk.Fn.join(",", allowedOrigins.valueAsList),
      TRUST_PROXY: "true",
      STORAGE_DRIVER: "dynamodb",
      DYNAMODB_TABLE_NAME: table.tableName,
      WORKFLOW_QUEUE_URL: workflowQueue.queueUrl,
      SSM_PARAMETER_PREFIX: parameterPrefix.valueAsString,
      LOCAL_SCHEDULER_ENABLED: "false",
      WORKFLOW_TIMEZONE: scheduleTimezone.valueAsString,
      SCHEDULED_RUN_SCOPE: "all",
      SCHEDULED_RUN_DRY_RUN: "false",
      PRODUCTIVE_ORG_ID: productiveOrgId.valueAsString,
      MICROSOFT_TOKEN_URL: microsoftTokenUrl.valueAsString,
      MICROSOFT_CLIENT_ID: microsoftClientId.valueAsString,
      HEIMDALL_SITE_ID: heimdallSiteId.valueAsString,
      HEIMDALL_LIST_ID: heimdallListId.valueAsString,
      HEIMDALL_BUDGET_VALID_TRUE_VALUE: heimdallBudgetValidTrueValue.valueAsString,
      HEIMDALL_BUDGET_VALID_FALSE_VALUE: heimdallBudgetValidFalseValue.valueAsString,
    };
    const code = lambda.Code.fromAsset(lambdaAssetDirectory);
    const apiFunction = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      handler: "api.handler",
      code,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(29),
      environment: {
        ...commonEnvironment,
        AUTH_MODE: "local-users",
        AUTH_COOKIE_SECURE: "true",
        SLACK_NOTIFICATIONS_ENABLED: slackNotificationsEnabled.valueAsString,
        PRODUCTIVE_API_KEY: "not-used-by-api-lambda",
        MICROSOFT_CLIENT_SECRET: "not-used-by-api-lambda",
      },
      tracing: lambda.Tracing.ACTIVE,
      logGroup: apiLogGroup,
    });
    const workflowFunction = new lambda.Function(this, "WorkflowFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      handler: "workflow.handler",
      code,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      reservedConcurrentExecutions: 1,
      environment: {
        ...commonEnvironment,
        AUTH_MODE: "static-token",
        API_TOKEN: "not-used-by-private-workflow-lambda",
        SLACK_NOTIFICATIONS_ENABLED: slackNotificationsEnabled.valueAsString,
      },
      tracing: lambda.Tracing.ACTIVE,
      logGroup: workerLogGroup,
    });

    table.grantReadWriteData(apiFunction);
    table.grantReadWriteData(workflowFunction);
    workflowQueue.grantSendMessages(apiFunction);
    workflowFunction.addEventSource(new lambdaEventSources.SqsEventSource(workflowQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));
    this.grantSecureParameterRead(apiFunction, parameterPrefix.valueAsString, [
      ...SECURE_PARAMETER_GROUPS.api,
      ...OPTIONAL_SECURE_PARAMETER_GROUPS.api,
    ]);
    this.grantSecureParameterRead(workflowFunction, parameterPrefix.valueAsString, [
      ...SECURE_PARAMETER_GROUPS.workflow,
      ...OPTIONAL_SECURE_PARAMETER_GROUPS.workflow,
    ]);

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${this.stackName}-api`,
      defaultIntegration: new apigwv2Integrations.HttpLambdaIntegration("ApiIntegration", apiFunction),
      corsPreflight: {
        allowCredentials: true,
        allowHeaders: ["authorization", "content-type", "x-request-id"],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowOrigins: allowedOrigins.valueAsList,
        maxAge: cdk.Duration.hours(1),
      },
    });
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: apiAccessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        status: "$context.status",
        responseLength: "$context.responseLength",
        integrationError: "$context.integrationErrorMessage",
      }),
    };
    defaultStage.defaultRouteSettings = {
      detailedMetricsEnabled: true,
      throttlingBurstLimit: 100,
      throttlingRateLimit: 50,
    };
    apiAccessLogGroup.grantWrite(new iam.ServicePrincipal("apigateway.amazonaws.com"));

    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    workflowQueue.grantSendMessages(schedulerRole);
    deadLetterQueue.grantSendMessages(schedulerRole);
    new scheduler.CfnSchedule(this, "DailySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: scheduleExpression.valueAsString,
      scheduleExpressionTimezone: scheduleTimezone.valueAsString,
      state: scheduleState.valueAsString,
      target: {
        arn: workflowQueue.queueArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({
          version: 1,
          trigger: "schedule",
          request: { scope: "all", limit: null, dryRun: false },
        }),
        deadLetterConfig: { arn: deadLetterQueue.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 3_600, maximumRetryAttempts: 2 },
      },
    });

    const alarmTopic = new sns.Topic(this, "AlarmTopic", { displayName: "Budget validation alarms" });
    const apiErrorAlarm = apiFunction.metricErrors().createAlarm(this, "ApiErrorAlarm", {
      threshold: 5,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const workerErrorAlarm = workflowFunction.metricErrors().createAlarm(this, "WorkerErrorAlarm", {
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const api5xxAlarm = httpApi.metricServerError().createAlarm(this, "Api5xxAlarm", {
      threshold: 5,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const deadLetterAlarm = deadLetterQueue.metricApproximateNumberOfMessagesVisible().createAlarm(this, "DeadLetterAlarm", {
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const alarm of [apiErrorAlarm, api5xxAlarm, workerErrorAlarm, deadLetterAlarm]) {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    }
    new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `${this.stackName}-operations`,
      widgets: [
        [new cloudwatch.GraphWidget({ title: "API requests and errors", left: [httpApi.metricCount(), httpApi.metricServerError(), apiFunction.metricErrors()], right: [apiFunction.metricDuration()] })],
        [new cloudwatch.GraphWidget({ title: "Workflow invocations, errors, and duration", left: [workflowFunction.metricInvocations(), workflowFunction.metricErrors()], right: [workflowFunction.metricDuration()] })],
        [new cloudwatch.GraphWidget({ title: "Workflow queue", left: [workflowQueue.metricApproximateNumberOfMessagesVisible(), deadLetterQueue.metricApproximateNumberOfMessagesVisible()], right: [workflowQueue.metricApproximateAgeOfOldestMessage()] })],
        [new cloudwatch.LogQueryWidget({ title: "Recent application errors", logGroupNames: [apiLogGroup.logGroupName, workerLogGroup.logGroupName], queryString: "fields @timestamp, @log, @message | filter level >= 50 | sort @timestamp desc | limit 50" })],
      ],
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "StateTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "WorkflowQueueUrl", { value: workflowQueue.queueUrl });
    new cdk.CfnOutput(this, "WorkflowDeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new cdk.CfnOutput(this, "SecureParameterPrefixOutput", { value: parameterPrefix.valueAsString });
    new cdk.CfnOutput(this, "AlarmTopicArn", { value: alarmTopic.topicArn });
  }

  private grantSecureParameterRead(fn: lambda.Function, prefix: string, names: readonly string[]): void {
    const parameterArns = names.map((name) => cdk.Fn.join("", [
      `arn:${cdk.Aws.PARTITION}:ssm:${this.region}:${this.account}:parameter`,
      prefix,
      `/${name}`,
    ]));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameters"],
      resources: parameterArns,
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: {
        StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` },
      },
    }));
  }
}
