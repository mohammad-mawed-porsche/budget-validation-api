import { randomUUID } from "node:crypto";

import type { NotificationPublisher } from "../clients/slackWebhookClient.js";
import { normalizeCostId } from "../domain/budgetValidation.js";
import type { HeimdallAffiliation, NotificationOutcome, NotificationRecord, ProductiveBudgetSnapshot, ValidationReason } from "../domain/models.js";
import type { WorkflowRepository } from "../repositories/workflowRepository.js";
import { buildInvalidBudgetSlackMessage } from "./slackMessage.js";

export interface NotificationPreparation {
  outcome: NotificationOutcome;
  record: NotificationRecord | null;
  error: string | null;
}

export class NotificationService {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly cooldownMilliseconds: number,
    private readonly now: () => Date = () => new Date(),
    private readonly uuid: () => string = randomUUID,
    private readonly publisher?: NotificationPublisher,
  ) {}

  private ownerIdentity(item: HeimdallAffiliation): string {
    if (item.ownerEmails.length > 0) {
      return item.ownerEmails.map((email) => email.trim().toLowerCase()).sort().join(",");
    }
    return item.ownerObjectId?.trim().toLowerCase() || "unassigned";
  }

  async prepareInvalidBudget(
    runId: string,
    item: HeimdallAffiliation,
    budget: ProductiveBudgetSnapshot | null,
    reason: ValidationReason,
    dryRun: boolean,
  ): Promise<NotificationPreparation> {
    if (dryRun) return { outcome: "dry-run", record: null, error: null };
    const ownerIdentity = this.ownerIdentity(item);

    const dedupeKey = `${normalizeCostId(item.costId)}:${ownerIdentity}`;
    const currentTime = this.now();
    const previous = await this.repository.getLatestNotification(dedupeKey);
    if (previous && previous.status !== "failed" && Date.parse(previous.nextEligibleAt) > currentTime.getTime()) {
      return { outcome: "cooldown", record: previous, error: null };
    }

    const nextEligibleAt = new Date(currentTime.getTime() + this.cooldownMilliseconds).toISOString();
    const slackMessage = buildInvalidBudgetSlackMessage({ runId, item, budget, reason, nextEligibleAt });
    const record: NotificationRecord = {
      id: this.uuid(),
      dedupeKey,
      runId,
      costId: item.costId,
      itemId: item.id,
      reason,
      ownerObjectId: item.ownerObjectId,
      ownerEmails: [...item.ownerEmails],
      status: "prepared",
      preparedAt: currentTime.toISOString(),
      deliveredAt: null,
      deliveryError: null,
      nextEligibleAt,
      message: slackMessage.text,
    };
    await this.repository.saveNotification(record);
    if (!this.publisher) return { outcome: "prepared", record, error: null };

    try {
      await this.publisher.publish(slackMessage);
      record.status = "sent";
      record.deliveredAt = this.now().toISOString();
      await this.repository.saveNotification(record);
      return { outcome: "sent", record, error: null };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Slack notification delivery failed.";
      record.status = "failed";
      record.deliveryError = error;
      record.nextEligibleAt = this.now().toISOString();
      await this.repository.saveNotification(record);
      return { outcome: "failed", record, error };
    }
  }
}
