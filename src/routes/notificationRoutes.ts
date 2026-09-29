import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { NotificationPublisher } from "../clients/slackWebhookClient.js";
import { sendApiError, sendValidationError } from "../http.js";
import type { WorkflowRepository } from "../repositories/workflowRepository.js";
import { buildSlackTestMessage } from "../services/slackMessage.js";

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const testMessageSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
}).strict();

export function registerNotificationRoutes(
  app: FastifyInstance,
  repository: WorkflowRepository,
  publisher?: NotificationPublisher,
) {
  app.get("/v1/notifications", async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, request.id, parsed.error);
    return reply.send({ items: await repository.listNotifications(parsed.data.limit) });
  });

  app.post("/v1/notifications/test", async (request, reply) => {
    const parsed = testMessageSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendValidationError(reply, request.id, parsed.error);
    if (!publisher) {
      return sendApiError(
        reply,
        503,
        request.id,
        "SLACK_DISABLED",
        "Slack notifications are not configured for this service.",
      );
    }

    try {
      await publisher.publish(buildSlackTestMessage(parsed.data.message));
      request.log.info({ messageLength: parsed.data.message.length }, "Slack test notification accepted");
      return reply.send({ status: "sent", requestId: request.id });
    } catch (error) {
      request.log.error({ err: error }, "Slack test notification failed");
      return sendApiError(
        reply,
        502,
        request.id,
        "SLACK_DELIVERY_FAILED",
        "Slack did not accept the test notification.",
      );
    }
  });
}
