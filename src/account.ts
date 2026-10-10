import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, homedir, platform, release, userInfo } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "zcode";
export const APP_VERSION = "3.14.5";
export const ZCODE_ORIGIN = "https://zcode.z.ai";
export const PLAN_ANTHROPIC_BASE = ZCODE_ORIGIN + "/api/v1/zcode-plan/anthropic";
export const PUBLIC_ANTHROPIC_BASE = "https://api.z.ai/api/anthropic";
export const PUBLIC_OPENAI_BASE = "https://api.z.ai/api/paas/v4";

const CREDENTIAL_PREFIX = "enc:v1:";
const CREDENTIALS_FILE = join(homedir(), ".zcode", "v2", "credentials.json");
const TELEMETRY_FILE = join(homedir(), ".zcode", "v2", "telemetry-state.json");

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface PlanModel {
  id: string;
  name: string;
  remaining?: number;
  total?: number;
}

export interface DetailedPlanBalance {
  id: string;
  name: string;
  remaining: number;
  total: number;
  used: number;
  expiresAt?: number;
}

export interface DetailedPlan {
  name: string;
  planId: string;
  status: string;
  description?: string;
  endsAt?: number;
  balances: DetailedPlanBalance[];
}

export interface ZCodeAccount {
  provider: "zai" | "bigmodel";
  userId?: string;
  name?: string;
  email?: string;
  jwt: string;
  accessToken?: string;
  apiKey?: string;
  plans: Array<{ name: string; status: string; models: string[] }>;
  detailedPlans?: DetailedPlan[];
  models: PlanModel[];
}

export const CATALOG: CatalogModel[] = [
  spec("glm-5.3", "GLM-5.3", 1_000_000, 128_000, true, ["text"], ["low", "high", "max"]),
  spec("glm-5.3-flash", "GLM-5.3-Flash", 1_000_000, 128_000, true, ["text", "image"], ["low", "high", "max"]),
  spec("glm-5.3-flashx", "GLM-5.3-FlashX", 1_000_000, 128_000, true, ["text", "image"], ["low", "high", "max"]),
  spec("glm-5.2", "GLM-5.2", 1_000_000, 128_000, true, ["text"], ["disabled", "high", "max"]),
  spec("glm-5.1", "GLM-5.1", 200_000, 64_000, true, ["text"], ["disabled", "enabled"]),
  spec("glm-5", "GLM-5", 200_000, 64_000, true, ["text"], ["disabled", "enabled"]),
  spec("glm-5-turbo", "GLM-5-Turbo", 200_000, 64_000, true, ["text"], ["disabled", "enabled"]),
  spec("glm-4.7", "GLM-4.7", 200_000, 128_000, true, ["text"], ["disabled", "enabled"]),
  spec("glm-4.6", "GLM-4.6", 200_000, 128_000, true, ["text"], ["disabled", "enabled"]),
  spec("glm-4.5", "GLM-4.5", 131_072, 98_304, true, ["text"], ["disabled", "enabled"]),
  spec("glm-4.5-air", "GLM-4.5-Air", 131_072, 98_304, true, ["text"], ["disabled", "enabled"]),
  spec("glm-5v-turbo", "GLM-5V-Turbo", 200_000, 128_000, true, ["text", "image"], ["disabled", "enabled"]),
  spec("glm-4.6v", "GLM-4.6V", 131_072, 32_768, false, ["text", "image"]),
  spec("glm-4.7-flash", "GLM-4.7-Flash", 200_000, 128_000, true, ["text"], ["disabled", "enabled"]),
];

function spec(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  reasoning: boolean,
  input: Array<"text" | "image">,
  levels?: string[],
): CatalogModel {
  const thinkingLevelMap = levels
    ? {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      }
    : undefined;
  return { id, name, contextWindow, maxTokens, reasoning, input, thinkingLevelMap };
}

const CATALOG_BY_ID = new Map(CATALOG.map((model) => [model.id, model]));

export function catalogModel(id: string, name = id): CatalogModel {
  return CATALOG_BY_ID.get(id.toLowerCase()) ?? {
    id: id.toLowerCase(),
    name,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text"],
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
  };
}

export function isJwt(value: string): boolean {
  return value.startsWith("eyJ") && value.split(".").length === 3;
}

export function sourceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "ZCode/" + APP_VERSION,
    "HTTP-Referer": ZCODE_ORIGIN,
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": APP_VERSION,
    "X-Platform": platform() + "-" + arch(),
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "X-Os-Category": platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux",
    "X-Os-Version": release(),
  };
  const deviceMid = readDeviceMid();
  if (deviceMid) headers["X-Device-Mid"] = deviceMid;
  return headers;
}

function readDeviceMid(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(TELEMETRY_FILE, "utf8")) as { deviceMid?: unknown };
    return typeof parsed.deviceMid === "string" ? parsed.deviceMid : undefined;
  } catch {
    return undefined;
  }
}

function credentialKey(): Buffer {
  const secret = process.env.ZCODE_CREDENTIAL_SECRET
    || "zcode-credential-fallback:" + platform() + ":" + homedir() + ":" + userInfo().username;
  return createHash("sha256").update(secret).digest();
}

export function decryptCredential(value: string): string {
  if (!value.startsWith(CREDENTIAL_PREFIX)) return value;
  const parts = value.slice(CREDENTIAL_PREFIX.length).split(".");
  const ivB64 = parts[0];
  const tagB64 = parts[1];
  const dataB64 = parts[2];
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("ZCode 凭证格式无法识别");
  const decipher = createDecipheriv("aes-256-gcm", credentialKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

export function loadDesktopCredentials(): Record<string, string> {
  const raw = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as Record<string, string>;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, decryptCredential(value)]));
}

export async function loadDesktopAccount(signal?: AbortSignal): Promise<ZCodeAccount> {
  const creds = loadDesktopCredentials();
  const provider = creds["oauth:active_provider"] === "bigmodel" ? "bigmodel" : "zai";
  const jwt = creds.zcodejwttoken?.trim();
  if (!jwt) throw new Error("本机 ZCode 还没有登录。请先在 ZCode 里登录，或在 pi 里选择浏览器登录。");
  const user = parseJson(creds["oauth:" + provider + ":user_info"]);
  const apiKey = Object.entries(creds).find(([key]) => key.endsWith(":api-key"))?.[1];
  const balance = await fetchPlanBalance(jwt, signal);
  return {
    provider,
    userId: stringField(user, "user_id"),
    name: stringField(user, "name"),
    email: stringField(user, "email"),
    jwt,
    accessToken: creds["oauth:" + provider + ":access_token"],
    apiKey,
    plans: balance.plans,
    detailedPlans: balance.detailedPlans,
    models: balance.models,
  };
}

export async function fetchPlanBalance(jwt: string, signal?: AbortSignal): Promise<{
  plans: ZCodeAccount["plans"];
  detailedPlans: DetailedPlan[];
  models: PlanModel[];
}> {
  const url = new URL("/api/v1/zcode-plan/billing/balance", ZCODE_ORIGIN);
  url.searchParams.set("app_version", APP_VERSION);
  const response = await fetch(url, {
    headers: { ...sourceHeaders(), Authorization: "Bearer " + jwt },
    signal,
  });
  const body = await readJson(response);
  if (!response.ok || body.code !== 0) {
    throw new Error(body.msg || "无法读取 ZCode 套餐（HTTP " + response.status + "）");
  }

  const rawPlans = asArray(body.data?.plans);
  const rawBalances = asArray(body.data?.balances);

  const plans = rawPlans.map((plan) => ({
    name: stringField(plan, "name") || stringField(plan, "plan_id") || "ZCode Plan",
    status: stringField(plan, "status") || "unknown",
    models: asArray(plan.entitlements).map((item) => modelIdFromEntitlement(item)).filter(Boolean),
  }));

  const detailedPlans: DetailedPlan[] = rawPlans.map((plan) => {
    const planId = stringField(plan, "plan_id") || "";
    const userPlanId = stringField(plan, "user_plan_id") || "";
    const name = stringField(plan, "name") || planId || "ZCode Plan";
    const status = stringField(plan, "status") || "unknown";
    const description = stringField(plan, "description");
    const endsAt = numberField(plan, "ends_at");

    const planBalances: DetailedPlanBalance[] = rawBalances
      .filter((b) => (planId && b.plan_id === planId) || (userPlanId && b.user_plan_id === userPlanId))
      .map((b) => ({
        id: modelIdFromEntitlement(b) || "",
        name: stringField(b, "show_name") || "",
        remaining: numberField(b, "remaining_units") ?? 0,
        total: numberField(b, "total_units") ?? 0,
        used: numberField(b, "used_units") ?? 0,
        expiresAt: numberField(b, "expires_at"),
      }))
      .filter((b) => b.id);

    return {
      name,
      planId,
      status,
      description,
      endsAt,
      balances: planBalances,
    };
  });

  // Calculate aggregated totals per model across all active plans
  const totalModelsMap = new Map<string, PlanModel>();
  for (const b of rawBalances) {
    const id = modelIdFromEntitlement(b);
    if (!id) continue;
    const name = stringField(b, "show_name") || catalogModel(id).name;
    const remaining = numberField(b, "remaining_units") ?? 0;
    const total = numberField(b, "total_units") ?? 0;

    const existing = totalModelsMap.get(id);
    if (!existing) {
      totalModelsMap.set(id, { id, name, remaining, total });
    } else {
      existing.remaining = (existing.remaining ?? 0) + remaining;
      existing.total = (existing.total ?? 0) + total;
    }
  }

  return {
    plans,
    detailedPlans,
    models: [...totalModelsMap.values()],
  };
}

export async function fetchPublicModels(apiKey: string, signal?: AbortSignal): Promise<PlanModel[]> {
  const response = await fetch(PUBLIC_ANTHROPIC_BASE + "/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    },
    signal,
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(body.error?.message || body.msg || "模型列表失败（HTTP " + response.status + "）");
  return asArray(body.data).map((item) => ({
    id: (stringField(item, "id") || "").toLowerCase(),
    name: stringField(item, "display_name") || stringField(item, "id") || "",
  })).filter((item) => item.id);
}

export async function startBrowserLogin(provider: "zai" | "bigmodel", signal?: AbortSignal): Promise<{
  authorizeUrl: string;
  pollToken: string;
  pollUrl: string;
  expiresAt: number;
  intervalMs: number;
}> {
  const pollToken = randomBytes(32).toString("hex");
  const response = await fetch(ZCODE_ORIGIN + "/api/v1/oauth/cli/init", {
    method: "POST",
    headers: {
      ...sourceHeaders(),
      Authorization: "Bearer " + pollToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ provider }),
    signal,
  });
  const body = await readJson(response);
  const data = body.data ?? {};
  if (!response.ok || body.code !== 0 || !data.flow_id || !data.authorize_url) {
    throw new Error(body.msg || "无法开始 ZCode 登录（HTTP " + response.status + "）");
  }
  const expiresAt = normalizeTimestamp(data.expires_at) ?? Date.now() + 5 * 60 * 1000;
  return {
    authorizeUrl: String(data.authorize_url),
    pollToken,
    pollUrl: ZCODE_ORIGIN + "/api/v1/oauth/cli/poll/" + encodeURIComponent(String(data.flow_id)),
    expiresAt,
    intervalMs: Math.max(1000, Number(data.poll_interval_sec || 2) * 1000),
  };
}

export async function pollBrowserLogin(pollUrl: string, pollToken: string, signal?: AbortSignal): Promise<{
  status: "pending" | "ready" | "failed";
  jwt?: string;
  accessToken?: string;
  name?: string;
  userId?: string;
}> {
  const response = await fetch(pollUrl, {
    headers: { ...sourceHeaders(), Authorization: "Bearer " + pollToken },
    signal,
  });
  const body = await readJson(response);
  if (!response.ok || body.code !== 0) {
    throw new Error(body.msg || "登录状态查询失败（HTTP " + response.status + "）");
  }
  const data = body.data ?? {};
  const status = String(data.status || "");
  if (status === "pending") return { status: "pending" };
  if (status === "failed") return { status: "failed" };
  if (status !== "ready") throw new Error("登录状态响应无法识别");
  const user = isRecord(data.user) ? data.user : {};
  const zai = isRecord(data.zai) ? data.zai : {};
  const bigmodel = isRecord(data.bigmodel) ? data.bigmodel : {};
  return {
    status: "ready",
    jwt: stringField(data, "token"),
    accessToken: stringField(zai, "access_token") || stringField(bigmodel, "access_token") || stringField(bigmodel, "accessToken"),
    name: stringField(user, "name") || stringField(user, "email"),
    userId: stringField(user, "user_id"),
  };
}

export function formatQuota(model: PlanModel): string {
  if (model.remaining == null) return model.name;
  const total = model.total == null ? "" : " / " + formatTokens(model.total);
  return model.name + " 剩余 " + formatTokens(model.remaining) + total;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + "M";
  if (value >= 1_000) return Math.round(value / 1_000) + "K";
  return String(value);
}

function modelIdFromEntitlement(value: unknown): string {
  const capability = asArray(isRecord(value) ? value.capabilities : undefined)
    .map((item) => String(item))
    .find((item) => item.startsWith("model:"));
  if (capability) return capability.slice("model:".length).toLowerCase();
  const show = stringField(value, "show_name");
  return show ? show.toLowerCase() : "";
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { msg: text.slice(0, 180) };
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}
