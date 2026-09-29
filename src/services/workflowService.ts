import { randomUUID } from "node:crypto";

import type { HeimdallBudgetSource } from "../clients/heimdallClient.js";
import type { ProductiveBudgetSource } from "../clients/productiveClient.js";
import { evaluateBudgets, normalizeCostId } from "../domain/budgetValidation.js";
import type {
  BudgetEvaluation,
  HeimdallAffiliation,
  RunRequest,
  RunResult,
  RunSummary,
  RunTrigger,
  WorkflowRun,
} from "../domain/models.js";
import type { WorkflowRepository } from "../repositories/workflowRepository.js";
import { mapConcurrent } from "../utils/concurrency.js";
import type { NotificationService } from "./notificationService.js";

export class WorkflowAlreadyRunningError extends Error {
  constructor(readonly runId: string) {
    super(`Budget validation run ${runId} is already in progress.`);
    this.name = "WorkflowAlreadyRunningError";
  }
}

export class WorkflowRunFailedError extends Error {
  constructor(readonly run: WorkflowRun) {
    super(run.error ?? "Budget validation run failed.");
    this.name = "WorkflowRunFailedError";
  }
}

function emptySummary(): RunSummary {
  return {
    selected: 0,
    processed: 0,
    valid: 0,
    invalid: 0,
    unknown: 0,
    heimdallUpdated: 0,
    notificationsPrepared: 0,
    errors: 0,
  };
}

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function failedLookup(message: string): BudgetEvaluation {
  return {
    decision: "unknown",
    reason: "productive-lookup-failed",
    matchedBudget: null,
    candidateBudgetIds: [],
    checks: [{ code: "lookup", label: message, passed: false }],
  };
}

export interface WorkflowServiceOptions {
  productiveConcurrency: number;
  timezone: string;
  lockTtlSeconds?: number;
  now?: () => Date;
  uuid?: () => string;
}

export class WorkflowService {
  private activeRunId: string | null = null;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly productive: ProductiveBudgetSource,
    private readonly heimdall: HeimdallBudgetSource,
    private readonly notifications: NotificationService,
    private readonly repository: WorkflowRepository,
    private readonly options: WorkflowServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format(this.now());
  }

  get activeRun() {
    return this.activeRunId;
  }

  async getRun(runId: string) {
    return this.repository.getRun(runId);
  }

  async listRuns(limit: number) {
    return this.repository.listRuns(limit);
  }

  private async evaluateCostIds(items: HeimdallAffiliation[], signal?: AbortSignal) {
    const requestedCostIds = new Map<string, string>();
    for (const item of items) {
      const normalized = normalizeCostId(item.costId);
      if (!requestedCostIds.has(normalized)) requestedCostIds.set(normalized, item.costId);
    }
    const entries = [...requestedCostIds.entries()];
    const today = dateInTimezone(this.now(), this.options.timezone);
    const evaluations = await mapConcurrent(entries, this.options.productiveConcurrency, async ([normalized, original]) => {
      try {
        const budgets = await this.productive.findBudgetsByCostId(original, signal);
        return [normalized, evaluateBudgets(budgets, today)] as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Productive lookup failed.";
        return [normalized, failedLookup(message)] as const;
      }
    });
    return new Map(evaluations);
  }

  private async processItem(
    runId: string,
    item: HeimdallAffiliation,
    evaluation: BudgetEvaluation,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    let heimdallUpdated = false;
    let error: string | null = evaluation.reason === "productive-lookup-failed"
      ? evaluation.checks[0]?.label ?? "Productive lookup failed."
      : null;
    const desiredValid = evaluation.decision === "valid" ? true : evaluation.decision === "invalid" ? false : null;

    if (!dryRun && desiredValid !== null && desiredValid !== item.valid) {
      try {
        await this.heimdall.updateValidity(item.costId, item.id, desiredValid, signal);
        heimdallUpdated = true;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Heimdall update failed.";
      }
    }

    let notification: RunResult["notification"] = "not-required";
    if (evaluation.decision === "invalid") {
      try {
        const prepared = await this.notifications.prepareInvalidBudget(
          runId,
          item,
          evaluation.matchedBudget,
          evaluation.reason,
          dryRun,
        );
        notification = prepared.outcome;
        if (prepared.error) error = [error, prepared.error].filter(Boolean).join(" ");
      } catch (cause) {
        error = [error, cause instanceof Error ? cause.message : "Notification preparation failed."]
          .filter(Boolean)
          .join(" ");
      }
    }

    return {
      itemId: item.id,
      costId: item.costId,
      normalizedCostId: normalizeCostId(item.costId),
      affiliation: { category: item.category, title: item.title, index: item.index },
      owner: { objectId: item.ownerObjectId, emails: [...item.ownerEmails] },
      previousValid: item.valid,
      decision: evaluation.decision,
      reason: evaluation.reason,
      matchedBudget: evaluation.matchedBudget,
      candidateBudgetIds: [...evaluation.candidateBudgetIds],
      checks: [...evaluation.checks],
      heimdallUpdated,
      notification,
      error,
    };
  }

  private async beginRun(request: RunRequest, trigger: RunTrigger, status: WorkflowRun["status"] = "running"): Promise<WorkflowRun> {
    if (this.activeRunId) throw new WorkflowAlreadyRunningError(this.activeRunId);
    const startedAt = this.now().toISOString();
    const run: WorkflowRun = {
      id: this.uuid(),
      trigger,
      status,
      dryRun: request.dryRun,
      scope: request.scope,
      limit: request.scope === "limit" ? request.limit : null,
      startedAt,
      finishedAt: null,
      summary: emptySummary(),
      results: [],
      error: null,
    };
    const lock = await this.repository.acquireRunLock(
      run.id,
      new Date(this.now().getTime() + (this.options.lockTtlSeconds ?? 21_600) * 1_000).toISOString(),
    );
    if (!lock.acquired) throw new WorkflowAlreadyRunningError(lock.currentRunId ?? "unknown");
    if (status === "running") this.activeRunId = run.id;
    try {
      await this.repository.saveRun(run);
      return run;
    } catch (error) {
      if (status === "running") this.activeRunId = null;
      await this.repository.releaseRunLock(run.id);
      throw error;
    }
  }

  private async executeRun(run: WorkflowRun, request: RunRequest, signal?: AbortSignal): Promise<WorkflowRun> {
    try {
      const allItems = await this.heimdall.listAffiliations(signal);
      const items = request.scope === "limit" ? allItems.slice(0, request.limit ?? 1) : allItems;
      run.summary.selected = items.length;
      const evaluations = await this.evaluateCostIds(items, signal);

      for (const item of items) {
        if (signal?.aborted) throw signal.reason;
        const evaluation = evaluations.get(normalizeCostId(item.costId))
          ?? failedLookup("No Productive evaluation was produced.");
        const result = await this.processItem(run.id, item, evaluation, request.dryRun, signal);
        run.results.push(result);
        run.summary.processed += 1;
        run.summary[result.decision] += 1;
        if (result.heimdallUpdated) run.summary.heimdallUpdated += 1;
        if (result.notification === "prepared" || result.notification === "sent") run.summary.notificationsPrepared += 1;
        if (result.error) run.summary.errors += 1;
        await this.repository.saveRun(run);
      }

      run.status = "completed";
      run.finishedAt = this.now().toISOString();
      await this.repository.saveRun(run);
      return run;
    } catch (cause) {
      run.status = "failed";
      run.finishedAt = this.now().toISOString();
      run.error = cause instanceof Error ? cause.message : "Budget validation run failed.";
      await this.repository.saveRun(run);
      throw new WorkflowRunFailedError(run);
    } finally {
      this.activeRunId = null;
      await this.repository.releaseRunLock(run.id);
    }
  }

  async run(request: RunRequest, trigger: RunTrigger = "manual", signal?: AbortSignal): Promise<WorkflowRun> {
    const run = await this.beginRun(request, trigger);
    return this.executeRun(run, request, signal);
  }

  async queue(request: RunRequest, trigger: RunTrigger = "manual"): Promise<WorkflowRun> {
    return this.beginRun(request, trigger, "queued");
  }

  async executeQueued(runId: string, request: RunRequest, signal?: AbortSignal): Promise<WorkflowRun> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new Error(`Queued workflow run ${runId} was not found.`);
    if (run.status === "completed") return run;
    if (run.status === "failed") throw new WorkflowRunFailedError(run);
    if (this.activeRunId && this.activeRunId !== run.id) throw new WorkflowAlreadyRunningError(this.activeRunId);
    this.activeRunId = run.id;
    run.status = "running";
    await this.repository.saveRun(run);
    return this.executeRun(run, request, signal);
  }

  async failQueued(runId: string, cause: unknown): Promise<void> {
    const run = await this.repository.getRun(runId);
    if (!run || run.status !== "queued") return;
    run.status = "failed";
    run.finishedAt = this.now().toISOString();
    run.error = cause instanceof Error ? cause.message : "The workflow could not be queued.";
    await this.repository.saveRun(run);
    await this.repository.releaseRunLock(run.id);
    if (this.activeRunId === run.id) this.activeRunId = null;
  }

  async start(request: RunRequest, trigger: RunTrigger = "manual"): Promise<WorkflowRun> {
    const run = await this.beginRun(request, trigger);
    const accepted = structuredClone(run);
    setImmediate(() => { void this.executeRun(run, request).catch(() => undefined); });
    return accepted;
  }
}
