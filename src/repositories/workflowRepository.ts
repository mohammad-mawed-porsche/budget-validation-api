import type { DailySchedule, NotificationRecord, WorkflowRun } from "../domain/models.js";

export interface WorkflowRepository {
  initialize(): Promise<void>;
  acquireRunLock(runId: string, expiresAt: string): Promise<{ acquired: boolean; currentRunId: string | null }>;
  releaseRunLock(runId: string): Promise<void>;
  saveRun(run: WorkflowRun): Promise<void>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  listRuns(limit: number): Promise<WorkflowRun[]>;
  saveNotification(notification: NotificationRecord): Promise<void>;
  getLatestNotification(dedupeKey: string): Promise<NotificationRecord | null>;
  listNotifications(limit: number): Promise<NotificationRecord[]>;
  getSchedule(): Promise<DailySchedule | null>;
  saveSchedule(schedule: DailySchedule): Promise<void>;
}
