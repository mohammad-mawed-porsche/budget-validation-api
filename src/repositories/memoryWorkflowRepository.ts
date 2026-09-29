import type { DailySchedule, NotificationRecord, WorkflowRun } from "../domain/models.js";
import type { WorkflowRepository } from "./workflowRepository.js";

export class MemoryWorkflowRepository implements WorkflowRepository {
  runs: WorkflowRun[] = [];
  notifications: NotificationRecord[] = [];
  schedule: DailySchedule | null = null;
  runLock: { runId: string; expiresAt: string } | null = null;

  async initialize() {}

  async acquireRunLock(runId: string, expiresAt: string) {
    if (this.runLock && Date.parse(this.runLock.expiresAt) > Date.now()) {
      return { acquired: false, currentRunId: this.runLock.runId };
    }
    this.runLock = { runId, expiresAt };
    return { acquired: true, currentRunId: runId };
  }

  async releaseRunLock(runId: string) {
    if (this.runLock?.runId === runId) this.runLock = null;
  }

  async saveRun(run: WorkflowRun) {
    this.runs = [structuredClone(run), ...this.runs.filter((candidate) => candidate.id !== run.id)];
  }

  async getRun(runId: string) {
    const run = this.runs.find((candidate) => candidate.id === runId);
    return run ? structuredClone(run) : null;
  }

  async listRuns(limit: number) {
    return structuredClone(this.runs.slice(0, limit));
  }

  async saveNotification(notification: NotificationRecord) {
    this.notifications = [
      structuredClone(notification),
      ...this.notifications.filter((candidate) => candidate.id !== notification.id),
    ];
  }

  async getLatestNotification(dedupeKey: string) {
    const found = this.notifications
      .filter((candidate) => candidate.dedupeKey === dedupeKey)
      .sort((left, right) => right.preparedAt.localeCompare(left.preparedAt))[0];
    return found ? structuredClone(found) : null;
  }

  async listNotifications(limit: number) {
    return structuredClone(this.notifications.slice(0, limit));
  }

  async getSchedule() {
    return this.schedule ? structuredClone(this.schedule) : null;
  }

  async saveSchedule(schedule: DailySchedule) {
    this.schedule = structuredClone(schedule);
  }
}
