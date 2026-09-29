import type { SlackTextObject, SlackWebhookMessage } from "../clients/slackWebhookClient.js";
import type { HeimdallAffiliation, ProductiveBudgetSnapshot, ValidationReason } from "../domain/models.js";

const reasonLabels: Record<ValidationReason, string> = {
  "budget-valid": "Budget is valid",
  "budget-exceeded": "Budget usage exceeds the total",
  "budget-not-positive": "Budget total is not positive",
  "productive-budget-missing": "Productive budget is missing",
  "budget-period-incomplete": "Budget period is incomplete",
  "no-active-budget": "No active budget was found",
  "ambiguous-active-budget": "Multiple active budgets were found",
  "budget-financials-incomplete": "Budget financials are incomplete",
  "productive-lookup-failed": "Productive lookup failed",
};

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function clipped(value: string, maximum = 500): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function code(value: string): string {
  return `\`${escapeMrkdwn(value.replaceAll("`", "ʼ"))}\``;
}

function field(label: string, value: string): SlackTextObject {
  return { type: "mrkdwn", text: `*${label}*\n${clipped(value)}` };
}

function amount(value: number | null, currency: string | null): string {
  if (value === null) return "Not available";
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value);
    } catch {
      // Fall back to a plain number when Productive contains an unsupported currency code.
    }
  }
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value)}${currency ? ` ${escapeMrkdwn(currency)}` : ""}`;
}

function affiliationName(item: HeimdallAffiliation): string {
  return [item.category, item.title].filter(Boolean).map((value) => escapeMrkdwn(value as string)).join(" · ") || "Not available";
}

function budgetName(budget: ProductiveBudgetSnapshot | null): string {
  if (!budget) return "No active budget";
  const name = escapeMrkdwn(budget.name ?? "Unnamed budget");
  return budget.number ? `${name} (${code(budget.number)})` : name;
}

function period(budget: ProductiveBudgetSnapshot | null): string {
  if (!budget?.startDate || !budget.endDate) return "Not available";
  return `${escapeMrkdwn(budget.startDate)} – ${escapeMrkdwn(budget.endDate)}`;
}

export interface InvalidBudgetSlackMessageInput {
  runId: string;
  item: HeimdallAffiliation;
  budget: ProductiveBudgetSnapshot | null;
  reason: ValidationReason;
  nextEligibleAt: string;
}

export function buildInvalidBudgetSlackMessage(input: InvalidBudgetSlackMessageInput): SlackWebhookMessage {
  const { runId, item, budget, reason, nextEligibleAt } = input;
  const owners = item.ownerEmails.length > 0
    ? item.ownerEmails.map(escapeMrkdwn).join(", ")
    : escapeMrkdwn(item.ownerObjectId ?? "Not assigned");
  const fallback = [
    "Budget validation requires attention",
    `Cost ID: ${item.costId}`,
    `Affiliation: ${[item.category, item.title].filter(Boolean).join(" · ") || "Not available"}`,
    `Affected owner: ${item.ownerEmails.join(", ") || item.ownerObjectId || "Not assigned"}`,
    `Reason: ${reasonLabels[reason]}`,
    `Productive budget: ${budget?.name ?? "No active budget"}`,
    `Used: ${amount(budget?.budgetUsed ?? null, budget?.currency ?? null)}`,
    `Total: ${amount(budget?.budgetTotal ?? null, budget?.currency ?? null)}`,
  ].join("\n");

  return {
    text: clipped(fallback, 3_000),
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Budget validation requires attention" },
      },
      {
        type: "section",
        fields: [
          field("Cost ID", code(item.costId)),
          field("Affected owner", owners),
          field("Reason", escapeMrkdwn(reasonLabels[reason])),
          field("Affiliation", affiliationName(item)),
          field("Productive budget", budgetName(budget)),
          field("Period", period(budget)),
          field("Budget used", amount(budget?.budgetUsed ?? null, budget?.currency ?? null)),
          field("Budget total", amount(budget?.budgetTotal ?? null, budget?.currency ?? null)),
        ],
      },
      { type: "divider" },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `Run ${code(runId)} · Heimdall item ${code(item.id)} · Next notification after ${code(nextEligibleAt)}`,
        }],
      },
    ],
  };
}

export function buildSlackTestMessage(message: string): SlackWebhookMessage {
  return {
    text: `Budget Validation API test\n${message}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Budget Validation API test" },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: escapeMrkdwn(message) },
      },
    ],
  };
}
