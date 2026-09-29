import { describe, expect, it } from "vitest";

import type { HeimdallBudgetSource } from "../src/clients/heimdallClient.js";
import type { ProductiveBudgetSource } from "../src/clients/productiveClient.js";
import type { HeimdallAffiliation, ProductiveBudgetSnapshot } from "../src/domain/models.js";
import { MemoryWorkflowRepository } from "../src/repositories/memoryWorkflowRepository.js";
import { NotificationService } from "../src/services/notificationService.js";
import { WorkflowService } from "../src/services/workflowService.js";

function affiliation(overrides: Partial<HeimdallAffiliation> = {}): HeimdallAffiliation {
  return {
    id: "item-1",
    uniqueId: "unique-1",
    costId: "DE30510.1.1",
    valid: true,
    category: "Team",
    title: "Design",
    index: 12,
    ownerObjectId: "owner-1",
    ownerEmails: ["owner@example.test"],
    ...overrides,
  };
}

function budget(overrides: Partial<ProductiveBudgetSnapshot> = {}): ProductiveBudgetSnapshot {
  return {
    id: "budget-1",
    costId: "DE30510.1.1",
    name: "Automation",
    number: "2026-1",
    currency: "EUR",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    budgetTotal: 100,
    budgetUsed: 110,
    budgetRemaining: -10,
    responsibleId: "responsible-1",
    customFields: { "17450": "DE30510.1.1" },
    ...overrides,
  };
}

describe("WorkflowService", () => {
  it("persists a queued run before a Lambda worker executes it", async () => {
    const repository = new MemoryWorkflowRepository();
    await repository.initialize();
    const workflow = new WorkflowService(
      { findBudgetsByCostId: async () => [] },
      { listAffiliations: async () => [], updateValidity: async () => {} },
      new NotificationService(repository, 7 * 86_400_000),
      repository,
      {
        productiveConcurrency: 1,
        timezone: "Europe/Berlin",
        uuid: () => "00000000-0000-4000-8000-000000000010",
      },
    );
    const request = { scope: "all" as const, limit: null, dryRun: true };

    const queued = await workflow.queue(request);
    expect(queued.status).toBe("queued");
    expect(repository.runLock?.runId).toBe(queued.id);

    const completed = await workflow.executeQueued(queued.id, request);
    expect(completed.status).toBe("completed");
    expect(repository.runLock).toBeNull();
  });

  it("never writes Invalid when Productive data is missing", async () => {
    const updates: unknown[] = [];
    const productive: ProductiveBudgetSource = { findBudgetsByCostId: async () => [] };
    const heimdall: HeimdallBudgetSource = {
      listAffiliations: async () => [affiliation()],
      updateValidity: async (...args) => { updates.push(args); },
    };
    const repository = new MemoryWorkflowRepository();
    await repository.initialize();
    const notifications = new NotificationService(repository, 7 * 86_400_000);
    const workflow = new WorkflowService(productive, heimdall, notifications, repository, {
      productiveConcurrency: 2,
      timezone: "Europe/Berlin",
      now: () => new Date("2026-09-15T10:00:00.000Z"),
      uuid: () => "00000000-0000-4000-8000-000000000001",
    });

    const run = await workflow.run({ scope: "all", limit: null, dryRun: false });

    expect(updates).toEqual([]);
    expect(run.summary).toMatchObject({ unknown: 1, invalid: 0, heimdallUpdated: 0 });
    expect(run.results[0]).toMatchObject({ decision: "unknown", reason: "productive-budget-missing" });
  });

  it("updates a confirmed invalid result and suppresses repeated owner notifications for seven days", async () => {
    let now = new Date("2026-09-15T10:00:00.000Z");
    let id = 0;
    const updates: Array<[string, string, boolean]> = [];
    const productive: ProductiveBudgetSource = { findBudgetsByCostId: async () => [budget()] };
    const heimdall: HeimdallBudgetSource = {
      listAffiliations: async () => [affiliation()],
      updateValidity: async (costId, itemId, valid) => { updates.push([costId, itemId, valid]); },
    };
    const repository = new MemoryWorkflowRepository();
    await repository.initialize();
    const notifications = new NotificationService(repository, 7 * 86_400_000, () => now, () => `notification-${++id}`);
    const workflow = new WorkflowService(productive, heimdall, notifications, repository, {
      productiveConcurrency: 2,
      timezone: "Europe/Berlin",
      now: () => now,
      uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    });

    const first = await workflow.run({ scope: "all", limit: null, dryRun: false });
    now = new Date("2026-09-16T10:00:00.000Z");
    const second = await workflow.run({ scope: "all", limit: null, dryRun: false });
    now = new Date("2026-09-23T10:00:01.000Z");
    const third = await workflow.run({ scope: "all", limit: null, dryRun: false });

    expect(updates).toEqual([
      ["DE30510.1.1", "item-1", false],
      ["DE30510.1.1", "item-1", false],
      ["DE30510.1.1", "item-1", false],
    ]);
    expect(first.results[0]?.notification).toBe("prepared");
    expect(second.results[0]?.notification).toBe("cooldown");
    expect(third.results[0]?.notification).toBe("prepared");
    expect(repository.notifications).toHaveLength(2);
  });

  it("queries Productive once per normalized Cost ID", async () => {
    const lookups: string[] = [];
    const productive: ProductiveBudgetSource = {
      findBudgetsByCostId: async (costId) => { lookups.push(costId); return [budget()]; },
    };
    const heimdall: HeimdallBudgetSource = {
      listAffiliations: async () => [affiliation(), affiliation({ id: "item-2", costId: " de30510.1.1 " })],
      updateValidity: async () => {},
    };
    const repository = new MemoryWorkflowRepository();
    await repository.initialize();
    const workflow = new WorkflowService(
      productive,
      heimdall,
      new NotificationService(repository, 7 * 86_400_000),
      repository,
      { productiveConcurrency: 2, timezone: "Europe/Berlin" },
    );

    await workflow.run({ scope: "all", limit: null, dryRun: true });
    expect(lookups).toEqual(["DE30510.1.1"]);
  });
});
