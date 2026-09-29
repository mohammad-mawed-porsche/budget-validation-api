import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";

import { buildApplication, type Application } from "../app.js";
import { loadEnvironment } from "../config/env.js";
import { loadSecureParameters } from "../config/parameterStore.js";
import { workflowQueueMessageSchema } from "../domain/workflowRequest.js";

let application: Promise<Application> | undefined;

async function getApplication(): Promise<Application> {
  application ??= loadSecureParameters("workflow")
    .then(() => buildApplication(loadEnvironment()))
    .catch((error) => {
      application = undefined;
      throw error;
    });
  return application;
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const runtime = await getApplication();
  const failures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(new Error("Workflow stopped before the Lambda execution deadline.")),
      Math.max(1, context.getRemainingTimeInMillis() - 10_000),
    );
    try {
      const message = workflowQueueMessageSchema.parse(JSON.parse(record.body));
      const run = message.runId
        ? await runtime.workflow.executeQueued(message.runId, message.request, abortController.signal)
        : await runtime.workflow.run(message.request, message.trigger, abortController.signal);
      runtime.app.log.info({ runId: run.id, summary: run.summary }, "Budget validation workflow completed");
    } catch (error) {
      runtime.app.log.error({ err: error, messageId: record.messageId }, "Budget validation workflow message failed");
      failures.push({ itemIdentifier: record.messageId });
    } finally {
      clearTimeout(timeout);
    }
  }

  return { batchItemFailures: failures };
}
