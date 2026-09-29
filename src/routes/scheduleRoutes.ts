import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireLimitForLimitedScope, runLimitSchema, runScopeSchema } from "../domain/workflowRequest.js";
import { sendApiError, sendValidationError } from "../http.js";
import type { ScheduleService } from "../services/scheduleService.js";

const scheduleSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "time must use 24-hour HH:mm format."),
  timezone: z.string().min(1).max(100),
  scope: runScopeSchema.default("all"),
  limit: runLimitSchema.default(null),
  dryRun: z.boolean().default(false),
}).strict().superRefine(requireLimitForLimitedScope);

export function registerScheduleRoutes(app: FastifyInstance, schedule: ScheduleService) {
  app.get("/v1/schedule", async (_request, reply) => reply.send(await schedule.get()));

  app.put("/v1/schedule", async (request, reply) => {
    const parsed = scheduleSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, request.id, parsed.error);
    try {
      return reply.send(await schedule.update({
        ...parsed.data,
        limit: parsed.data.scope === "limit" ? parsed.data.limit : null,
      }));
    } catch (error) {
      if (error instanceof RangeError) {
        return sendApiError(reply, 400, request.id, "INVALID_TIMEZONE", "timezone must be a valid IANA timezone.");
      }
      request.log.error({ err: error }, "AWS schedule update failed");
      return sendApiError(reply, 502, request.id, "SCHEDULE_UPDATE_FAILED", "The AWS schedule could not be updated.");
    }
  });
}
