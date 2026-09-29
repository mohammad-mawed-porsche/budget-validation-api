import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireLimitForLimitedScope, runLimitSchema, runScopeSchema } from "../domain/workflowRequest.js";
import { sendApiError, sendValidationError } from "../http.js";
import type { RunStarter } from "../services/runDispatcher.js";
import type { WorkflowService } from "../services/workflowService.js";

const runSchema = z.object({
  scope: runScopeSchema.default("limit"),
  limit: runLimitSchema.default(10),
  dryRun: z.boolean().default(false),
}).strict().superRefine(requireLimitForLimitedScope);

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const paramsSchema = z.object({ runId: z.string().uuid() });

export function registerRunRoutes(app: FastifyInstance, workflow: WorkflowService, starter: RunStarter = workflow) {
  app.post("/v1/runs", async (request, reply) => {
    const parsed = runSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendValidationError(reply, request.id, parsed.error);
    const run = await starter.start({
      scope: parsed.data.scope,
      limit: parsed.data.scope === "limit" ? parsed.data.limit : null,
      dryRun: parsed.data.dryRun,
    });
    const location = `/v1/runs/${run.id}`;
    reply.header("Location", location);
    return reply.code(202).send({ runId: run.id, status: run.status, location });
  });

  app.get("/v1/runs", async (request, reply) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, request.id, parsed.error);
    return reply.send({ items: await workflow.listRuns(parsed.data.limit) });
  });

  app.get("/v1/runs/:runId", async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return sendValidationError(reply, request.id, parsed.error);
    const run = await workflow.getRun(parsed.data.runId);
    if (!run) return sendApiError(reply, 404, request.id, "RUN_NOT_FOUND", "Workflow run was not found.");
    return reply.send(run);
  });
}
