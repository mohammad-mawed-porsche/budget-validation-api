import type { DailySchedule, RunRequest } from "../domain/models.js";
import type { WorkflowRepository } from "../repositories/workflowRepository.js";
import type { WorkflowService } from "./workflowService.js";

export type ScheduleUpdate = Omit<DailySchedule, "updatedAt" | "lastTriggeredLocalDate">;

export interface ScheduleController {
  update(input: ScheduleUpdate): Promise<void>;
}

interface ScheduleLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

function localDateAndTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

export function assertTimezone(timezone: string) {
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
}

export class ScheduleService {
  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly workflow: Pick<WorkflowService, "run">,
    private readonly logger: ScheduleLogger,
    private readonly pollIntervalMs: number,
    private readonly now: () => Date = () => new Date(),
    private readonly controller?: ScheduleController,
  ) {}

  async get(): Promise<DailySchedule> {
    return (await this.repository.getSchedule()) ?? {
      enabled: false,
      time: "06:00",
      timezone: "Europe/Berlin",
      scope: "all",
      limit: null,
      dryRun: false,
      updatedAt: this.now().toISOString(),
      lastTriggeredLocalDate: null,
    };
  }

  async update(input: ScheduleUpdate): Promise<DailySchedule> {
    assertTimezone(input.timezone);
    const previous = await this.get();
    const timingChanged = previous.time !== input.time || previous.timezone !== input.timezone;
    const normalizedInput: ScheduleUpdate = {
      ...input,
      limit: input.scope === "limit" ? input.limit : null,
    };
    const schedule: DailySchedule = {
      ...normalizedInput,
      updatedAt: this.now().toISOString(),
      lastTriggeredLocalDate: timingChanged ? null : previous.lastTriggeredLocalDate,
    };
    // Persist only after AWS accepts the same normalized settings.
    await this.controller?.update(normalizedInput);
    await this.repository.saveSchedule(schedule);
    return schedule;
  }

  async runNow(request: RunRequest) {
    return this.workflow.run(request, "manual");
  }

  async tick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      const schedule = await this.get();
      if (!schedule.enabled) return;
      const local = localDateAndTime(this.now(), schedule.timezone);
      if (local.time !== schedule.time || schedule.lastTriggeredLocalDate === local.date) return;

      await this.repository.saveSchedule({ ...schedule, lastTriggeredLocalDate: local.date });
      await this.workflow.run({
        scope: schedule.scope,
        limit: schedule.limit,
        dryRun: schedule.dryRun,
      }, "schedule");
    } catch (error) {
      this.logger.error({ err: error }, "Scheduled budget validation failed");
    } finally {
      this.tickInProgress = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
