import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowRun } from "../src/domain/models.js";
import { FileWorkflowRepository } from "../src/repositories/fileWorkflowRepository.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileWorkflowRepository", () => {
  it("persists workflow state across repository instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "budget-validation-"));
    directories.push(directory);
    const file = path.join(directory, "store.json");
    const run: WorkflowRun = {
      id: "run-1",
      trigger: "manual",
      status: "completed",
      dryRun: true,
      scope: "all",
      limit: null,
      startedAt: "2026-09-15T10:00:00.000Z",
      finishedAt: "2026-09-15T10:00:01.000Z",
      summary: { selected: 0, processed: 0, valid: 0, invalid: 0, unknown: 0, heimdallUpdated: 0, notificationsPrepared: 0, errors: 0 },
      results: [],
      error: null,
    };
    const first = new FileWorkflowRepository(file, { runs: 10, notifications: 10 });
    await first.initialize();
    await first.saveRun(run);

    const second = new FileWorkflowRepository(file, { runs: 10, notifications: 10 });
    await second.initialize();
    await expect(second.getRun("run-1")).resolves.toEqual(run);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, runs: [{ id: "run-1" }] });
  });
});
