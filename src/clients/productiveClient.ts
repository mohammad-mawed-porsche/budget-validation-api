import { normalizeCostId } from "../domain/budgetValidation.js";
import type { ProductiveBudgetSnapshot } from "../domain/models.js";
import { fetchWithRetry, safeUpstreamMessage, UpstreamError } from "../utils/upstream.js";

interface ProductiveRecord {
  id?: unknown;
  attributes?: Record<string, unknown> | null;
}

export interface ProductiveBudgetSource {
  findBudgetsByCostId(costId: string, signal?: AbortSignal): Promise<ProductiveBudgetSnapshot[]>;
}

export interface ProductiveClientConfig {
  baseUrl: string;
  apiKey: string;
  organizationId: string;
  costCenterFieldId: string;
  pageSize: number;
  maxPagesPerCostId: number;
  minRequestIntervalMs: number;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

class StartRateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private lastStartAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly sleep: (milliseconds: number) => Promise<void>,
  ) {}

  async wait(): Promise<void> {
    const turn = this.tail.then(async () => {
      const delay = Math.max(0, this.lastStartAt + this.intervalMs - Date.now());
      if (delay > 0) await this.sleep(delay);
      this.lastStartAt = Date.now();
    });
    this.tail = turn.catch(() => undefined);
    await turn;
  }
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return number(object.amount ?? object.value ?? object.cents ?? object.raw);
  }
  return null;
}

export function readCostId(customFields: unknown, fieldId: string): string | null {
  if (customFields && !Array.isArray(customFields) && typeof customFields === "object") {
    const object = customFields as Record<string, unknown>;
    return text(object[fieldId] ?? object.value ?? object.name);
  }
  if (Array.isArray(customFields)) {
    const field = customFields.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const object = candidate as Record<string, unknown>;
      return String(object.id ?? object.field_id ?? object.custom_field_id) === fieldId;
    }) as Record<string, unknown> | undefined;
    return field ? text(field.value ?? field.name) : null;
  }
  return text(customFields);
}

function hasWorkflowFields(record: ProductiveRecord): boolean {
  const attributes = record.attributes;
  if (!attributes) return false;
  return ["custom_fields", "date", "end_date", "budget_total", "budget_used"].every((field) =>
    Object.prototype.hasOwnProperty.call(attributes, field),
  );
}

export class ProductiveClient implements ProductiveBudgetSource {
  private readonly limiter: StartRateLimiter;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly config: ProductiveClientConfig) {
    this.sleep = config.sleepImpl ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.limiter = new StartRateLimiter(config.minRequestIntervalMs, this.sleep);
  }

  private async request(path: string, signal?: AbortSignal): Promise<ProductiveRecord[] | ProductiveRecord | null> {
    await this.limiter.wait();
    const url = new URL(path.replace(/^\/+/, ""), `${this.config.baseUrl.replace(/\/$/, "")}/`);
    const response = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.api+json",
          "X-Auth-Token": this.config.apiKey,
          "X-Organization-Id": this.config.organizationId,
        },
        ...(signal ? { signal } : {}),
      },
      {
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
        retryBaseMs: this.config.retryBaseMs,
        ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
        ...(this.config.sleepImpl ? { sleepImpl: this.config.sleepImpl } : {}),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new UpstreamError(
        `Productive API request failed (${response.status}): ${safeUpstreamMessage(body)}`,
        response.status,
      );
    }
    const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
    if (!payload || !(Array.isArray(payload.data) || (payload.data && typeof payload.data === "object"))) {
      throw new UpstreamError("Productive API returned an invalid JSON:API response.");
    }
    return payload.data as ProductiveRecord[] | ProductiveRecord;
  }

  private listPath(costId: string, page: number): string {
    const query = new URLSearchParams({
      "filter[type]": "2",
      [`filter[custom_fields][${this.config.costCenterFieldId}]`]: costId,
      "page[size]": String(this.config.pageSize),
      "page[number]": String(page),
    });
    return `/deals?${query.toString()}`;
  }

  private toSnapshot(record: ProductiveRecord): ProductiveBudgetSnapshot | null {
    const id = text(record.id);
    const attributes = record.attributes ?? {};
    const costId = readCostId(attributes.custom_fields, this.config.costCenterFieldId)
      ?? readCostId(attributes[`custom_field_${this.config.costCenterFieldId}`], this.config.costCenterFieldId);
    if (!id || !costId) return null;
    const customFields = attributes.custom_fields && typeof attributes.custom_fields === "object" && !Array.isArray(attributes.custom_fields)
      ? { ...(attributes.custom_fields as Record<string, unknown>) }
      : {};
    return {
      id,
      costId,
      name: text(attributes.name),
      number: text(attributes.number),
      currency: text(attributes.currency),
      startDate: text(attributes.date ?? attributes.start_date),
      endDate: text(attributes.end_date),
      budgetTotal: number(attributes.budget_total),
      budgetUsed: number(attributes.budget_used),
      budgetRemaining: number(attributes.budget_remaining),
      responsibleId: text(attributes.responsible_id),
      customFields,
    };
  }

  async findBudgetsByCostId(costId: string, signal?: AbortSignal): Promise<ProductiveBudgetSnapshot[]> {
    const rows: ProductiveRecord[] = [];
    for (let page = 1; page <= this.config.maxPagesPerCostId; page += 1) {
      const data = await this.request(this.listPath(costId, page), signal);
      const batch = Array.isArray(data) ? data : [];
      rows.push(...batch);
      if (batch.length < this.config.pageSize) break;
      if (page === this.config.maxPagesPerCostId) {
        throw new UpstreamError(`Productive results for Cost ID ${costId} exceeded the pagination limit.`);
      }
    }

    const detailed = await Promise.all(rows.map(async (row) => {
      if (hasWorkflowFields(row)) return row;
      const id = text(row.id);
      if (!id) return row;
      const detail = await this.request(`/deals/${encodeURIComponent(id)}`, signal);
      return detail && !Array.isArray(detail)
        ? { ...row, attributes: { ...(row.attributes ?? {}), ...(detail.attributes ?? {}) } }
        : row;
    }));

    const normalized = normalizeCostId(costId);
    return detailed
      .map((row) => this.toSnapshot(row))
      .filter((budget): budget is ProductiveBudgetSnapshot =>
        budget !== null && normalizeCostId(budget.costId) === normalized,
      );
  }
}
