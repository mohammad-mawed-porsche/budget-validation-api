import type { FastifyInstance } from "fastify";

import type { WorkflowService } from "../services/workflowService.js";

export function registerHealthRoutes(app: FastifyInstance, workflow: WorkflowService) {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready", activeRunId: workflow.activeRun }));
}
