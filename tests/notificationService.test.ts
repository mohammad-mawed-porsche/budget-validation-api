import { describe, expect, it, vi } from "vitest";

import type { HeimdallAffiliation, ProductiveBudgetSnapshot } from "../src/domain/models.js";
import { MemoryWorkflowRepository } from "../src/repositories/memoryWorkflowRepository.js";
import { NotificationService } from "../src/services/notificationService.js";

const item: HeimdallAffiliation = {
  id: "item-1",
  uniqueId: "unique-1",
  costId: "DE30510.1.1",
  valid: false,
  category: "Team",
  title: "Design",
  index: 12,
  ownerObjectId: "owner-1",
  ownerEmails: ["owner@example.test"],
};

const budget: ProductiveBudgetSnapshot = {
  id: "budget-1",
  costId: "DE30510.1.1",
  name: "Design budget",
  number: "2026-1",
  currency: "EUR",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  budgetTotal: 100,
  budgetUsed: 110,
  budgetRemaining: -10,
  responsibleId: "responsible-1",
  customFields: {},
};

describe("NotificationService", () => {
  it("delivers through Slack and starts the cooldown only after success", async () => {
    let now = new Date("2026-09-23T10:00:00.000Z");
    const repository = new MemoryWorkflowRepository();
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    await repository.initialize();
    const service = new NotificationService(
      repository,
      7 * 86_400_000,
      () => now,
      () => "notification-1",
      publisher,
    );

    const first = await service.prepareInvalidBudget("run-1", item, budget, "budget-exceeded", false);
    now = new Date("2026-09-24T10:00:00.000Z");
    const second = await service.prepareInvalidBudget("run-2", item, budget, "budget-exceeded", false);

    expect(first).toMatchObject({ outcome: "sent", error: null, record: { status: "sent" } });
    expect(second.outcome).toBe("cooldown");
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Cost ID: DE30510.1.1"),
      blocks: expect.arrayContaining([expect.objectContaining({ type: "section" })]),
    }));
    expect(repository.notifications).toHaveLength(1);
  });

  it("records delivery failures and allows the next run to retry", async () => {
    let id = 0;
    const repository = new MemoryWorkflowRepository();
    const publisher = { publish: vi.fn().mockRejectedValue(new Error("Slack unavailable")) };
    await repository.initialize();
    const service = new NotificationService(
      repository,
      7 * 86_400_000,
      () => new Date("2026-09-23T10:00:00.000Z"),
      () => `notification-${++id}`,
      publisher,
    );

    const first = await service.prepareInvalidBudget("run-1", item, budget, "budget-exceeded", false);
    const second = await service.prepareInvalidBudget("run-2", item, budget, "budget-exceeded", false);

    expect(first).toMatchObject({ outcome: "failed", error: "Slack unavailable", record: { status: "failed" } });
    expect(second.outcome).toBe("failed");
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(repository.notifications).toHaveLength(2);
  });

  it("does not call Slack during a dry run", async () => {
    const repository = new MemoryWorkflowRepository();
    const publisher = { publish: vi.fn() };
    await repository.initialize();
    const service = new NotificationService(repository, 7 * 86_400_000, undefined, undefined, publisher);

    await expect(service.prepareInvalidBudget("run-1", item, budget, "budget-exceeded", true)).resolves.toMatchObject({
      outcome: "dry-run",
      record: null,
    });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("posts channel warnings even when Heimdall has no assigned owner", async () => {
    const repository = new MemoryWorkflowRepository();
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    await repository.initialize();
    const service = new NotificationService(
      repository,
      7 * 86_400_000,
      () => new Date("2026-09-23T10:00:00.000Z"),
      () => "notification-unassigned",
      publisher,
    );

    const result = await service.prepareInvalidBudget(
      "run-unassigned",
      { ...item, ownerEmails: [], ownerObjectId: null },
      budget,
      "budget-exceeded",
      false,
    );

    expect(result).toMatchObject({
      outcome: "sent",
      record: { dedupeKey: "DE30510.1.1:unassigned", ownerEmails: [], ownerObjectId: null },
    });
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Affected owner: Not assigned"),
    }));
  });
});
