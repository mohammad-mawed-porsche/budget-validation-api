import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

import type { WorkflowQueueMessage } from "../domain/workflowRequest.js";
import type { RunRequest, RunTrigger, WorkflowRun } from "../domain/models.js";
import type { WorkflowService } from "./workflowService.js";

export interface RunStarter {
  start(request: RunRequest, trigger?: RunTrigger): Promise<WorkflowRun>;
}

export class SqsRunDispatcher implements RunStarter {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly queueUrl: string,
    private readonly client = new SQSClient({}),
  ) {}

  async start(request: RunRequest, trigger: RunTrigger = "manual"): Promise<WorkflowRun> {
    const run = await this.workflow.queue(request, trigger);
    const message: WorkflowQueueMessage = { version: 1, runId: run.id, trigger, request };
    try {
      await this.client.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }));
      return run;
    } catch (error) {
      await this.workflow.failQueued(run.id, error);
      throw error;
    }
  }
}
