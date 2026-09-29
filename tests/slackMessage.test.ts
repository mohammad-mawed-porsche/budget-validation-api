import { describe, expect, it } from "vitest";

import type { HeimdallAffiliation, ProductiveBudgetSnapshot } from "../src/domain/models.js";
import { buildInvalidBudgetSlackMessage } from "../src/services/slackMessage.js";

const item: HeimdallAffiliation = {
  id: "197",
  uniqueId: "item-197",
  costId: "DE500320.1.1",
  valid: false,
  category: "Portfolio",
  title: "Backbone & Platforms",
  index: 1,
  ownerObjectId: "owner-1",
  ownerEmails: ["owner@example.test"],
};

const budget: ProductiveBudgetSnapshot = {
  id: "603512",
  costId: "DE500320.1.1",
  name: "Team: Design <2026>",
  number: "B-2026",
  currency: "EUR",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  budgetTotal: 100_000,
  budgetUsed: 112_500,
  budgetRemaining: -12_500,
  responsibleId: "responsible-1",
  customFields: { "17450": "DE500320.1.1" },
};

describe("Slack budget messages", () => {
  it("keeps the Cost ID and budget facts in both fallback text and blocks", () => {
    const result = buildInvalidBudgetSlackMessage({
      runId: "run-1",
      item,
      budget,
      reason: "budget-exceeded",
      nextEligibleAt: "2026-10-05T10:00:00.000Z",
    });

    expect(result.text).toContain("Cost ID: DE500320.1.1");
    expect(result.text).toContain("Affected owner: owner@example.test");
    expect(result.text).toContain("Budget usage exceeds the total");
    expect(result.text).toContain("€112,500.00");
    expect(JSON.stringify(result.blocks)).toContain("`DE500320.1.1`");
    expect(JSON.stringify(result.blocks)).toContain("Backbone &amp; Platforms");
    expect(JSON.stringify(result.blocks)).toContain("Team: Design &lt;2026&gt;");
    expect(JSON.stringify(result.blocks)).toContain("owner@example.test");
    expect(JSON.stringify(result.blocks)).toContain("2026-10-05T10:00:00.000Z");
  });

  it("handles an invalid budget without Productive financial data", () => {
    const result = buildInvalidBudgetSlackMessage({
      runId: "run-2",
      item,
      budget: null,
      reason: "budget-not-positive",
      nextEligibleAt: "2026-10-05T10:00:00.000Z",
    });

    expect(result.text).toContain("Productive budget: No active budget");
    expect(result.text).toContain("Used: Not available");
    expect(result.blocks).toHaveLength(4);
  });

  it("keeps unassigned budgets visible in the channel", () => {
    const result = buildInvalidBudgetSlackMessage({
      runId: "run-3",
      item: { ...item, ownerEmails: [], ownerObjectId: null },
      budget,
      reason: "budget-exceeded",
      nextEligibleAt: "2026-10-05T10:00:00.000Z",
    });

    expect(result.text).toContain("Affected owner: Not assigned");
    expect(JSON.stringify(result.blocks)).toContain("*Affected owner*\\nNot assigned");
  });
});
