import { describe, expect, it, vi } from "vitest";

import { HeimdallClient } from "../src/clients/heimdallClient.js";

function client(fetchImpl: typeof fetch) {
  return new HeimdallClient({
    tokenUrl: "https://login.example/token",
    clientId: "client",
    clientSecret: "secret",
    scope: "scope",
    graphBaseUrl: "https://graph.example/v1.0",
    siteId: "site",
    listId: "list",
    maxListPages: 5,
    trueValue: "True",
    falseValue: "False",
    timeoutMs: 1_000,
    maxRetries: 0,
    retryBaseMs: 1,
    fetchImpl,
  });
}

describe("HeimdallClient", () => {
  it("loads Cost IDs and resolves owner emails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3_600 }))
      .mockResolvedValueOnce(Response.json({ value: [{
        id: "17",
        sharepointIds: { listItemUniqueId: "unique-17" },
        fields: {
          CostCenterId: "DE100560.1.1",
          BudgetValid: "True",
          BudgetOwnerObjectID: "owner-1",
          Category: "Team",
          Title: "Design",
          AffiliationIndex: 12,
          Deleted: false,
        },
      }] }))
      .mockResolvedValueOnce(Response.json({ mail: "owner@example.test", otherMails: ["other@example.test"] }));

    await expect(client(fetchMock).listAffiliations()).resolves.toEqual([{
      id: "17",
      uniqueId: "unique-17",
      costId: "DE100560.1.1",
      valid: true,
      category: "Team",
      title: "Design",
      index: 12,
      ownerObjectId: "owner-1",
      ownerEmails: ["owner@example.test", "other@example.test"],
    }]);
  });

  it("verifies the exact item Cost ID before updating it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3_600 }))
      .mockResolvedValueOnce(Response.json({ id: "17", fields: { CostCenterId: "WRONG", Deleted: false } }));

    await expect(client(fetchMock).updateValidity("EXPECTED", "17", false)).rejects.toThrow(
      "no longer matches Cost ID EXPECTED",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
