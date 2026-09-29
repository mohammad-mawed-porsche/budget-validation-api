import type { HeimdallAffiliation } from "../domain/models.js";
import { fetchWithRetry, safeUpstreamMessage, UpstreamError } from "../utils/upstream.js";

export interface HeimdallBudgetSource {
  listAffiliations(signal?: AbortSignal): Promise<HeimdallAffiliation[]>;
  updateValidity(costId: string, itemId: string, valid: boolean, signal?: AbortSignal): Promise<void>;
}

export interface HeimdallClientConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  graphBaseUrl: string;
  siteId: string;
  listId: string;
  maxListPages: number;
  trueValue: string;
  falseValue: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

interface GraphListItem {
  id?: unknown;
  sharepointIds?: { listItemUniqueId?: unknown } | null;
  fields?: Record<string, unknown> | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isDeleted(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

export class HeimdallClient implements HeimdallBudgetSource {
  private tokenCache: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: HeimdallClientConfig) {}

  private requestOptions() {
    return {
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      retryBaseMs: this.config.retryBaseMs,
      ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
      ...(this.config.sleepImpl ? { sleepImpl: this.config.sleepImpl } : {}),
    };
  }

  private async token(signal?: AbortSignal): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) return this.tokenCache.value;
    const response = await fetchWithRetry(
      this.config.tokenUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: this.config.scope,
        }),
        ...(signal ? { signal } : {}),
      },
      this.requestOptions(),
    );
    if (!response.ok) throw new UpstreamError(`Microsoft identity rejected the request (${response.status}).`, response.status);
    const payload = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!payload || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new UpstreamError("Microsoft identity returned an invalid token response.");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3_600;
    this.tokenCache = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(1, expiresIn - 60) * 1_000,
    };
    return payload.access_token;
  }

  private ensureGraphUrl(url: URL) {
    if (url.origin !== new URL(this.config.graphBaseUrl).origin) {
      throw new UpstreamError("Microsoft Graph returned an unsafe pagination URL.");
    }
  }

  private async graph(url: URL, token: string, init: RequestInit): Promise<Response> {
    this.ensureGraphUrl(url);
    return fetchWithRetry(url, {
      ...init,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...init.headers },
    }, this.requestOptions());
  }

  private parseValid(value: unknown): boolean | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value.trim().toLowerCase() === this.config.trueValue.toLowerCase()) return true;
    if (typeof value === "string" && value.trim().toLowerCase() === this.config.falseValue.toLowerCase()) return false;
    throw new UpstreamError(`Unsupported Heimdall BudgetValid value: ${JSON.stringify(value)}.`);
  }

  private toAffiliation(raw: GraphListItem): HeimdallAffiliation | null {
    const fields = raw.fields ?? {};
    const id = text(raw.id);
    const costId = text(fields.CostCenterId);
    if (!id || !costId || isDeleted(fields.Deleted)) return null;
    return {
      id,
      uniqueId: text(raw.sharepointIds?.listItemUniqueId),
      costId,
      valid: this.parseValid(fields.BudgetValid),
      category: text(fields.Category),
      title: text(fields.Title),
      index: typeof fields.AffiliationIndex === "number" && Number.isFinite(fields.AffiliationIndex)
        ? fields.AffiliationIndex
        : null,
      ownerObjectId: text(fields.BudgetOwnerObjectID),
      ownerEmails: [],
    };
  }

  private listUrl(): URL {
    const base = this.config.graphBaseUrl.replace(/\/$/, "");
    const url = new URL(`${base}/sites/${encodeURIComponent(this.config.siteId)}/lists/${encodeURIComponent(this.config.listId)}/items`);
    url.searchParams.set("$expand", "fields($select=BudgetValid,BudgetOwnerObjectID,CostCenterId,Category,Title,AffiliationIndex,Deleted)");
    url.searchParams.set("$select", "id,sharepointIds");
    url.searchParams.set("$top", "999");
    return url;
  }

  private async ownerEmails(ownerId: string, token: string, signal?: AbortSignal): Promise<string[]> {
    const url = new URL(`/v1.0/users/${encodeURIComponent(ownerId)}`, `${this.config.graphBaseUrl.replace(/\/$/, "")}/`);
    const basePath = new URL(this.config.graphBaseUrl).pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/users/${encodeURIComponent(ownerId)}`;
    url.searchParams.set("$select", "mail,otherMails");
    const response = await this.graph(url, token, { method: "GET", ...(signal ? { signal } : {}) });
    if (!response.ok) return [];
    const payload = (await response.json().catch(() => null)) as { mail?: unknown; otherMails?: unknown } | null;
    if (!payload) return [];
    const emails = [payload.mail, ...(Array.isArray(payload.otherMails) ? payload.otherMails : [])]
      .filter((email): email is string => typeof email === "string" && email.includes("@"))
      .map((email) => email.trim());
    return [...new Map(emails.map((email) => [email.toLowerCase(), email])).values()];
  }

  async listAffiliations(signal?: AbortSignal): Promise<HeimdallAffiliation[]> {
    const token = await this.token(signal);
    const affiliations: HeimdallAffiliation[] = [];
    let next: URL | null = this.listUrl();

    for (let page = 0; next && page < this.config.maxListPages; page += 1) {
      const response = await this.graph(next, token, { method: "GET", ...(signal ? { signal } : {}) });
      if (!response.ok) {
        throw new UpstreamError(
          `Microsoft Graph list query failed (${response.status}): ${safeUpstreamMessage(await response.text())}`,
          response.status,
        );
      }
      const payload = (await response.json().catch(() => null)) as { value?: unknown; "@odata.nextLink"?: unknown } | null;
      if (!payload || !Array.isArray(payload.value)) throw new UpstreamError("Microsoft Graph returned an invalid list response.");
      for (const raw of payload.value as GraphListItem[]) {
        const affiliation = this.toAffiliation(raw);
        if (affiliation) affiliations.push(affiliation);
      }
      const nextLink = payload["@odata.nextLink"];
      if (nextLink === undefined) {
        next = null;
      } else if (typeof nextLink === "string" && nextLink) {
        next = new URL(nextLink);
      } else {
        throw new UpstreamError("Microsoft Graph returned an invalid pagination URL.");
      }
    }
    if (next) throw new UpstreamError("Microsoft Graph list query exceeded the pagination limit.");

    const ownerIds = [...new Set(affiliations
      .flatMap((item) => (item.ownerObjectId ?? "").split(";"))
      .map((ownerId) => ownerId.trim())
      .filter(Boolean))];
    const emailPairs = await Promise.all(ownerIds.map(async (ownerId) => {
      try {
        return [ownerId, await this.ownerEmails(ownerId, token, signal)] as const;
      } catch {
        return [ownerId, [] as string[]] as const;
      }
    }));
    const emailMap = new Map(emailPairs);
    return affiliations.map((item) => ({
      ...item,
      ownerEmails: [...new Map(
        (item.ownerObjectId ?? "")
          .split(";")
          .flatMap((ownerId) => emailMap.get(ownerId.trim()) ?? [])
          .map((email) => [email.toLowerCase(), email]),
      ).values()],
    }));
  }

  async updateValidity(costId: string, itemId: string, valid: boolean, signal?: AbortSignal): Promise<void> {
    const token = await this.token(signal);
    const base = this.config.graphBaseUrl.replace(/\/$/, "");
    const itemUrl = new URL(`${base}/sites/${encodeURIComponent(this.config.siteId)}/lists/${encodeURIComponent(this.config.listId)}/items/${encodeURIComponent(itemId)}`);
    itemUrl.searchParams.set("$expand", "fields($select=CostCenterId,Deleted)");
    itemUrl.searchParams.set("$select", "id");
    const itemResponse = await this.graph(itemUrl, token, { method: "GET", ...(signal ? { signal } : {}) });
    if (!itemResponse.ok) throw new UpstreamError(`Heimdall item lookup failed (${itemResponse.status}).`, itemResponse.status);
    const item = (await itemResponse.json().catch(() => null)) as GraphListItem | null;
    if (!item || text(item.id) !== itemId || text(item.fields?.CostCenterId) !== costId || isDeleted(item.fields?.Deleted)) {
      throw new UpstreamError(`Heimdall item ${itemId} no longer matches Cost ID ${costId}.`);
    }

    const fieldsUrl = new URL(`${base}/sites/${encodeURIComponent(this.config.siteId)}/lists/${encodeURIComponent(this.config.listId)}/items/${encodeURIComponent(itemId)}/fields`);
    const response = await this.graph(fieldsUrl, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ BudgetValid: valid ? this.config.trueValue : this.config.falseValue }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new UpstreamError(
        `Heimdall update failed (${response.status}): ${safeUpstreamMessage(await response.text())}`,
        response.status,
      );
    }
  }
}
