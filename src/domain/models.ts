export type RunTrigger = "manual" | "schedule";
export type RunStatus = "queued" | "running" | "completed" | "failed";
export type ValidationDecision = "valid" | "invalid" | "unknown";

export type ValidationReason =
  | "budget-valid"
  | "budget-exceeded"
  | "budget-not-positive"
  | "productive-budget-missing"
  | "budget-period-incomplete"
  | "no-active-budget"
  | "ambiguous-active-budget"
  | "budget-financials-incomplete"
  | "productive-lookup-failed";

export interface ProductiveBudgetSnapshot {
  id: string;
  costId: string;
  name: string | null;
  number: string | null;
  currency: string | null;
  startDate: string | null;
  endDate: string | null;
  budgetTotal: number | null;
  budgetUsed: number | null;
  budgetRemaining: number | null;
  responsibleId: string | null;
  customFields: Record<string, unknown>;
}

export interface HeimdallAffiliation {
  id: string;
  uniqueId: string | null;
  costId: string;
  valid: boolean | null;
  category: string | null;
  title: string | null;
  index: number | null;
  ownerObjectId: string | null;
  ownerEmails: string[];
}

export interface RuleCheck {
  code: string;
  label: string;
  passed: boolean | null;
}

export interface BudgetEvaluation {
  decision: ValidationDecision;
  reason: ValidationReason;
  matchedBudget: ProductiveBudgetSnapshot | null;
  candidateBudgetIds: string[];
  checks: RuleCheck[];
}

export type NotificationOutcome = "prepared" | "sent" | "failed" | "cooldown" | "missing-owner" | "not-required" | "dry-run";

export interface RunResult {
  itemId: string;
  costId: string;
  normalizedCostId: string;
  affiliation: {
    category: string | null;
    title: string | null;
    index: number | null;
  };
  owner: {
    objectId: string | null;
    emails: string[];
  };
  previousValid: boolean | null;
  decision: ValidationDecision;
  reason: ValidationReason;
  matchedBudget: ProductiveBudgetSnapshot | null;
  candidateBudgetIds: string[];
  checks: RuleCheck[];
  heimdallUpdated: boolean;
  notification: NotificationOutcome;
  error: string | null;
}

export interface RunSummary {
  selected: number;
  processed: number;
  valid: number;
  invalid: number;
  unknown: number;
  heimdallUpdated: number;
  notificationsPrepared: number;
  errors: number;
}

export interface WorkflowRun {
  id: string;
  trigger: RunTrigger;
  status: RunStatus;
  dryRun: boolean;
  scope: "all" | "limit";
  limit: number | null;
  startedAt: string;
  finishedAt: string | null;
  summary: RunSummary;
  results: RunResult[];
  error: string | null;
}

export interface NotificationRecord {
  id: string;
  dedupeKey: string;
  runId: string;
  costId: string;
  itemId: string;
  reason: ValidationReason;
  ownerObjectId: string | null;
  ownerEmails: string[];
  status: "prepared" | "sent" | "failed";
  preparedAt: string;
  deliveredAt: string | null;
  deliveryError: string | null;
  nextEligibleAt: string;
  message: string;
}

export interface DailySchedule {
  enabled: boolean;
  time: string;
  timezone: string;
  scope: "all" | "limit";
  limit: number | null;
  dryRun: boolean;
  updatedAt: string;
  lastTriggeredLocalDate: string | null;
}

export interface RunRequest {
  scope: "all" | "limit";
  limit: number | null;
  dryRun: boolean;
}
