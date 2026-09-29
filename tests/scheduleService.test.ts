import { describe, expect, it, vi } from "vitest";

import type { HeimdallBudgetSource } from "../src/clients/heimdallClient.js";
import type { ProductiveBudgetSource } from "../src/clients/productiveClient.js";
import { MemoryWorkflowRepository } from "../src/repositories/memoryWorkflowRepository.js";
import { NotificationService } from "../src/services/notificationService.js";
import { ScheduleService, type ScheduleUpdate } from "../src/services/scheduleService.js";
import { WorkflowService } from "../src/services/workflowService.js";

describe("ScheduleService", () => {
  function updateFixture() {
    const repository = new MemoryWorkflowRepository();
    const workflow = { run: vi.fn<WorkflowService["run"]>() };
    const controller = { update: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
    const schedule = new ScheduleService(
      repository, workflow, { error: vi.fn() }, 30_000,
      () => new Date("2026-09-29T12:00:00.000Z"), controller,
    );
    const input: ScheduleUpdate = {
      enabled: false, time: "16:45", timezone: "Europe/Berlin",
      scope: "all", limit: null, dryRun: false,
    };
    return { repository, workflow, controller, schedule, input };
  }

  it("normalizes an all-scope limit once for both AWS and persisted state", async () => {
    const { repository, workflow, controller, schedule, input } = updateFixture();
    const updated = await schedule.update({ ...input, limit: 25 });

    expect(controller.update).toHaveBeenCalledWith(input);
    expect(updated.limit).toBeNull();
    expect(await repository.getSchedule()).toEqual(updated);
    expect(workflow.run).not.toHaveBeenCalled();
  });

  it("keeps the saved schedule unchanged when AWS rejects an update", async () => {
    const { repository, workflow, controller, schedule, input } = updateFixture();
    const previous = await schedule.update(input);
    controller.update.mockRejectedValueOnce(new Error("AWS update rejected"));

    await expect(schedule.update({ ...input, enabled: true })).rejects.toThrow("AWS update rejected");
    expect(await repository.getSchedule()).toEqual(previous);
    expect(workflow.run).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone before changing AWS or saved state", async () => {
    const { repository, controller, schedule, input } = updateFixture();

    await expect(schedule.update({ ...input, timezone: "Invalid/Timezone" })).rejects.toThrow(RangeError);
    expect(controller.update).not.toHaveBeenCalled();
    expect(await repository.getSchedule()).toBeNull();
  });

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
    const controller = { update: vi.fn(async () => {}) };
    const schedule = new ScheduleService(repository, workflow, logger, 30_000, () => now, controller);
    await schedule.update({ enabled: true, time: "06:30", timezone: "Europe/Berlin", scope: "all", limit: null, dryRun: true });
    expect(controller.update).toHaveBeenCalledWith({
      enabled: true,
      time: "06:30",
      timezone: "Europe/Berlin",
      scope: "all",
      limit: null,
      dryRun: true,
    });

    await schedule.tick();
    await schedule.tick();
    expect(await repository.listRuns(10)).toHaveLength(1);

    now = new Date("2026-09-16T04:30:00.000Z");
    await schedule.tick();
    expect(await repository.listRuns(10)).toHaveLength(2);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
