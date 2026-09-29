import { z } from "zod";

export const runScopeSchema = z.enum(["all", "limit"]);
export const runLimitSchema = z.number().int().min(1).max(10_000).nullable();

export function requireLimitForLimitedScope(
  value: { scope: "all" | "limit"; limit: number | null },
  context: z.RefinementCtx,
) {
  if (value.scope === "limit" && value.limit === null) {
    context.addIssue({ code: "custom", path: ["limit"], message: "limit is required when scope is limit." });
  }
}

export const workflowRunRequestSchema = z.object({
  scope: runScopeSchema,
  limit: runLimitSchema,
  dryRun: z.boolean(),
}).strict().superRefine(requireLimitForLimitedScope);

export const workflowQueueMessageSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid().optional(),
  trigger: z.enum(["manual", "schedule"]),
  request: workflowRunRequestSchema,
}).strict();

export type WorkflowQueueMessage = z.infer<typeof workflowQueueMessageSchema>;

