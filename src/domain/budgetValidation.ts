import type {
  BudgetEvaluation,
  ProductiveBudgetSnapshot,
  RuleCheck,
} from "./models.js";

export function normalizeCostId(value: string): string {
  return value.trim().toUpperCase();
}

function validIsoDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function periodState(budget: ProductiveBudgetSnapshot, today: string) {
  if (!validIsoDate(budget.startDate) || !validIsoDate(budget.endDate)) return "incomplete" as const;
  return budget.startDate <= today && today <= budget.endDate ? "active" as const : "inactive" as const;
}

function check(code: string, label: string, passed: boolean | null): RuleCheck {
  return { code, label, passed };
}

export function evaluateBudgets(
  candidates: ProductiveBudgetSnapshot[],
  today: string,
): BudgetEvaluation {
  if (candidates.length === 0) {
    return {
      decision: "unknown",
      reason: "productive-budget-missing",
      matchedBudget: null,
      candidateBudgetIds: [],
      checks: [check("exists", "Productive budget exists", false)],
    };
  }

  const withIncompletePeriods = candidates.filter((budget) => periodState(budget, today) === "incomplete");
  const active = candidates.filter((budget) => periodState(budget, today) === "active");
  const baseChecks = [
    check("exists", "Productive budget exists", true),
    check("period-complete", "Budget period is complete", withIncompletePeriods.length === 0),
  ];

  if (active.length === 0) {
    return {
      decision: "unknown",
      reason: withIncompletePeriods.length > 0 ? "budget-period-incomplete" : "no-active-budget",
      matchedBudget: null,
      candidateBudgetIds: candidates.map((budget) => budget.id),
      checks: [...baseChecks, check("active-period", "Exactly one budget is active", false)],
    };
  }

  if (active.length > 1) {
    return {
      decision: "unknown",
      reason: "ambiguous-active-budget",
      matchedBudget: null,
      candidateBudgetIds: candidates.map((budget) => budget.id),
      checks: [...baseChecks, check("active-period", "Exactly one budget is active", false)],
    };
  }

  const budget = active[0];
  if (!budget) throw new Error("Active budget selection failed.");
  const financialsComplete = budget.budgetTotal !== null && budget.budgetUsed !== null;
  const positive = budget.budgetTotal !== null ? budget.budgetTotal > 0 : null;
  const withinBudget = financialsComplete
    ? (budget.budgetUsed as number) <= (budget.budgetTotal as number)
    : null;
  const checks = [
    ...baseChecks,
    check("active-period", "Exactly one budget is active", true),
    check("financials-complete", "Budget total and usage are available", financialsComplete),
    check("positive-total", "Budget total is greater than zero", positive),
    check("within-budget", "Budget usage does not exceed total", withinBudget),
  ];

  if (!financialsComplete) {
    return {
      decision: "unknown",
      reason: "budget-financials-incomplete",
      matchedBudget: budget,
      candidateBudgetIds: candidates.map((candidate) => candidate.id),
      checks,
    };
  }

  if (!positive) {
    return {
      decision: "invalid",
      reason: "budget-not-positive",
      matchedBudget: budget,
      candidateBudgetIds: candidates.map((candidate) => candidate.id),
      checks,
    };
  }

  if (!withinBudget) {
    return {
      decision: "invalid",
      reason: "budget-exceeded",
      matchedBudget: budget,
      candidateBudgetIds: candidates.map((candidate) => candidate.id),
      checks,
    };
  }

  return {
    decision: "valid",
    reason: "budget-valid",
    matchedBudget: budget,
    candidateBudgetIds: candidates.map((candidate) => candidate.id),
    checks,
  };
}
