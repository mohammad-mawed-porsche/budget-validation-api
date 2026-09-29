import { describe, expect, it, vi } from "vitest";

import { ProductiveClient } from "../src/clients/productiveClient.js";

describe("ProductiveClient", () => {
  it("queries by Cost ID and retains the budget fields required by the workflow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "3462781",
      attributes: {
        name: "Global Website 2026",
        number: "B-2026",
        currency: "EUR",
        date: "2026-01-01",
        end_date: "2026-12-31",
        budget_total: 4_000_000,
        budget_used: 2_466_940,
        budget_remaining: 1_533_060,
        responsible_id: 42,
        custom_fields: { "17450": "DE100560.1.1", "123776": "316360" },
      },
    }] }, { headers: { "content-type": "application/vnd.api+json" } }));
    const client = new ProductiveClient({
      baseUrl: "https://productive.example/api/v2",
      apiKey: "secret",
      organizationId: "org",
      costCenterFieldId: "17450",
      pageSize: 200,
      maxPagesPerCostId: 5,
      minRequestIntervalMs: 0,
      timeoutMs: 1_000,
      maxRetries: 0,
      retryBaseMs: 1,
      fetchImpl: fetchMock,
    });

    await expect(client.findBudgetsByCostId("DE100560.1.1")).resolves.toEqual([{
      id: "3462781",
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
      customFields: { "17450": "DE100560.1.1", "123776": "316360" },
    }]);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(calledUrl.pathname).toBe("/api/v2/deals");
    expect(calledUrl.searchParams.get("filter[custom_fields][17450]")).toBe("DE100560.1.1");
    expect(calledUrl.searchParams.get("filter[type]")).toBe("2");
  });

  it("locally rejects records returned for another Cost ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "wrong",
      attributes: {
        date: "2026-01-01",
        end_date: "2026-12-31",
        budget_total: 100,
        budget_used: 10,
        custom_fields: { "17450": "OTHER" },
      },
    }] }));
    const client = new ProductiveClient({
      baseUrl: "https://productive.example/api/v2",
      apiKey: "secret",
      organizationId: "org",
      costCenterFieldId: "17450",
      pageSize: 200,
      maxPagesPerCostId: 5,
      minRequestIntervalMs: 0,
      timeoutMs: 1_000,
      maxRetries: 0,
      retryBaseMs: 1,
      fetchImpl: fetchMock,
    });
    await expect(client.findBudgetsByCostId("EXPECTED")).resolves.toEqual([]);
  });
});
