import { describe, expect, it, vi } from "vitest";

import type { HeimdallBudgetSource } from "../src/clients/heimdallClient.js";
import type { ProductiveBudgetSource } from "../src/clients/productiveClient.js";
import { MemoryWorkflowRepository } from "../src/repositories/memoryWorkflowRepository.js";
import { NotificationService } from "../src/services/notificationService.js";
import { ScheduleService } from "../src/services/scheduleService.js";
import { WorkflowService } from "../src/services/workflowService.js";

describe("ScheduleService", () => {
  it("runs once at the configured local time and not twice on the same day", async () => {
    let now = new Date("2026-09-15T04:30:00.000Z"); // 06:30 Europe/Berlin (CEST)
    let nextId = 0;
    const repository = new MemoryWorkflowRepository();
    await repository.initialize();
    const productive: ProductiveBudgetSource = { findBudgetsByCostId: async () => [] };
    const heimdall: HeimdallBudgetSource = { listAffiliations: async () => [], updateValidity: async () => {} };
    const workflow = new WorkflowService(
      productive,
      heimdall,
      new NotificationService(repository, 7 * 86_400_000, () => now),
      repository,
      {
        productiveConcurrency: 1,
        timezone: "Europe/Berlin",
        now: () => now,
        uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
      },
    );
    const logger = { error: vi.fn() };
    const schedule = new ScheduleService(repository, workflow, logger, 30_000, () => now);
    await schedule.update({ enabled: true, time: "06:30", timezone: "Europe/Berlin", scope: "all", limit: null, dryRun: true });

    await schedule.tick();
    await schedule.tick();
    expect(await repository.listRuns(10)).toHaveLength(1);

    now = new Date("2026-09-16T04:30:00.000Z");
    await schedule.tick();
    expect(await repository.listRuns(10)).toHaveLength(2);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
