import { describe, expect, it } from "vitest";

import { evaluateBudgets, normalizeCostId } from "../src/domain/budgetValidation.js";
import type { ProductiveBudgetSnapshot } from "../src/domain/models.js";

function budget(overrides: Partial<ProductiveBudgetSnapshot> = {}): ProductiveBudgetSnapshot {
  return {
    id: "budget-1",
    costId: "DE100560.1.1",
    name: "Global Website 2026",
    number: "B-2026",
    currency: "EUR",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    budgetTotal: 4_000_000,
    budgetUsed: 2_466_940,
    budgetRemaining: 1_533_060,
    responsibleId: "42",
    customFields: { "17450": "DE100560.1.1" },
    ...overrides,
  };
}

describe("budget validation", () => {
  it("normalizes Cost IDs without discarding punctuation", () => {
    expect(normalizeCostId("  de100560.1.1 ")).toBe("DE100560.1.1");
  });

  it("selects the one active budget while retaining historical candidates", () => {
    const result = evaluateBudgets([
      budget({ id: "2025", startDate: "2025-01-01", endDate: "2025-12-31" }),
      budget({ id: "2026" }),
    ], "2026-09-15");

    expect(result).toMatchObject({
      decision: "valid",
      reason: "budget-valid",
      matchedBudget: { id: "2026", name: "Global Website 2026", currency: "EUR" },
      candidateBudgetIds: ["2025", "2026"],
    });
  });

  it("marks a confirmed overrun invalid", () => {
    expect(evaluateBudgets([
      budget({ budgetTotal: 7_027_422, budgetUsed: 7_030_550 }),
    ], "2026-09-15")).toMatchObject({ decision: "invalid", reason: "budget-exceeded" });
  });

  it.each([
    [[], "productive-budget-missing"],
    [[budget({ startDate: null })], "budget-period-incomplete"],
    [[budget({ startDate: "2025-01-01", endDate: "2025-12-31" })], "no-active-budget"],
    [[budget({ id: "one" }), budget({ id: "two" })], "ambiguous-active-budget"],
    [[budget({ budgetUsed: null })], "budget-financials-incomplete"],
  ] as const)("keeps incomplete or unsafe data unknown", (budgets, reason) => {
    expect(evaluateBudgets([...budgets], "2026-09-15")).toMatchObject({ decision: "unknown", reason });
  });
});
