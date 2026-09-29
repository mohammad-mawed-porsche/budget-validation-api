import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DailySchedule, NotificationRecord, WorkflowRun } from "../domain/models.js";
import type { WorkflowRepository } from "./workflowRepository.js";

interface StoreData {
  version: 1;
  runs: WorkflowRun[];
  notifications: NotificationRecord[];
  schedule: DailySchedule | null;
  runLock?: { runId: string; expiresAt: string } | null;
}

const emptyStore = (): StoreData => ({ version: 1, runs: [], notifications: [], schedule: null, runLock: null });

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FileWorkflowRepository implements WorkflowRepository {
  private data: StoreData = emptyStore();
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly limits: { runs: number; notifications: number },
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoreData>;
      if (parsed.version !== 1 || !Array.isArray(parsed.runs) || !Array.isArray(parsed.notifications)) {
        throw new Error("Unsupported or invalid workflow store format.");
      }
      this.data = {
        version: 1,
        runs: parsed.runs,
        notifications: parsed.notifications,
        schedule: parsed.schedule ?? null,
        runLock: parsed.runLock ?? null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = emptyStore();
      await this.persist();
    }
    this.initialized = true;
  }

  private assertInitialized() {
    if (!this.initialized) throw new Error("Workflow repository has not been initialized.");
  }

  private async persist() {
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    this.assertInitialized();
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const result = operation();
      await this.persist();
      return result;
    } finally {
      release();
    }
  }

  private async ready() {
    this.assertInitialized();
    await this.queue;
  }

  async acquireRunLock(runId: string, expiresAt: string) {
    return this.mutate(() => {
      const current = this.data.runLock;
      if (current && Date.parse(current.expiresAt) > Date.now()) {
        return { acquired: false, currentRunId: current.runId };
      }
      this.data.runLock = { runId, expiresAt };
      return { acquired: true, currentRunId: runId };
    });
  }

  async releaseRunLock(runId: string) {
    await this.mutate(() => {
      if (this.data.runLock?.runId === runId) this.data.runLock = null;
    });
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    await this.mutate(() => {
      const index = this.data.runs.findIndex((candidate) => candidate.id === run.id);
      if (index >= 0) this.data.runs[index] = clone(run);
      else this.data.runs.unshift(clone(run));
      this.data.runs = this.data.runs
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, this.limits.runs);
    });
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    await this.ready();
    const run = this.data.runs.find((candidate) => candidate.id === runId);
    return run ? clone(run) : null;
  }

  async listRuns(limit: number): Promise<WorkflowRun[]> {
    await this.ready();
    return this.data.runs.slice(0, limit).map((run) => {
      const summary = clone(run);
      summary.results = [];
      return summary;
    });
  }

  async saveNotification(notification: NotificationRecord): Promise<void> {
    await this.mutate(() => {
      const index = this.data.notifications.findIndex((candidate) => candidate.id === notification.id);
      if (index >= 0) this.data.notifications[index] = clone(notification);
      else this.data.notifications.unshift(clone(notification));
      this.data.notifications = this.data.notifications
        .sort((left, right) => right.preparedAt.localeCompare(left.preparedAt))
        .slice(0, this.limits.notifications);
    });
  }

  async getLatestNotification(dedupeKey: string): Promise<NotificationRecord | null> {
    await this.ready();
    const found = this.data.notifications
      .filter((candidate) => candidate.dedupeKey === dedupeKey)
      .sort((left, right) => right.preparedAt.localeCompare(left.preparedAt))[0];
    return found ? clone(found) : null;
  }

  async listNotifications(limit: number): Promise<NotificationRecord[]> {
    await this.ready();
    return clone(this.data.notifications.slice(0, limit));
  }

  async getSchedule(): Promise<DailySchedule | null> {
    await this.ready();
    return this.data.schedule ? clone(this.data.schedule) : null;
  }

  async saveSchedule(schedule: DailySchedule): Promise<void> {
    await this.mutate(() => {
      this.data.schedule = clone(schedule);
    });
  }
}
