import { spawn } from "node:child_process";
import {
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type CatalogModel,
  PLAN_ANTHROPIC_BASE,
  PUBLIC_ANTHROPIC_BASE,
  type PlanModel,
  catalogModel,
  fetchPlanBalance,
  fetchPublicModels,
  formatQuota,
  isJwt,
  loadDesktopAccount,
  pollBrowserLogin,
  startBrowserLogin,
} from "../src/account.ts";
import { streamZcodeDirect } from "../src/direct-client.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function toProviderModel(model: CatalogModel) {
  return {
    id: model.id,
    name: model.name + (model.id.includes("flash") ? " (ZCode Start Plan - 快速)" : " (ZCode Start Plan - 强推理)"),
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: ZERO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function modelsFromPlan(models: PlanModel[]) {
  const seen = new Set<string>();
  const result = [];
  for (const item of models) {
    const catalog = catalogModel(item.id, item.name);
    if (seen.has(catalog.id)) continue;
    seen.add(catalog.id);
    result.push(toProviderModel(catalog));
  }
  return result.length ? result : [
    toProviderModel(catalogModel("glm-5.3-flash")),
    toProviderModel(catalogModel("glm-5.3")),
  ];
}

async function discoverModels(apiKey: string, signal?: AbortSignal) {
  if (isJwt(apiKey)) {
    try {
      const balance = await fetchPlanBalance(apiKey, signal);
      return modelsFromPlan(balance.models);
    } catch {
      return [
        toProviderModel(catalogModel("glm-5.3-flash")),
        toProviderModel(catalogModel("glm-5.3")),
      ];
    }
  }
  return modelsFromPlan(await fetchPublicModels(apiKey, signal));
}

function streamZcode(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const apiKey = options?.apiKey;

  // If using public API Key (e.g. key.secret format), route through public Anthropic endpoint
  if (apiKey && !isJwt(apiKey)) {
    return anthropicMessagesApi().streamSimple(
      { ...model, baseUrl: PUBLIC_ANTHROPIC_BASE } as Model<"anthropic-messages">,
      context,
      options
    );
  }

  // Pure direct HTTP streaming from Pi to Z.ai (zero app-server subprocess)
  return streamZcodeDirect(model, context, options, apiKey || "");
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  let desktopAccountName = "";
  try {
    const acc = await loadDesktopAccount(callbacks.signal);
    if (acc.name) desktopAccountName = ` (${acc.name} - Start Plan)`;
  } catch {
    // Ignore
  }

  const choice = await callbacks.onSelect({
    message: "登录 ZCode 账号",
    options: [
      { id: "desktop", label: `使用本机 ZCode 客户端账号${desktopAccountName}` },
      { id: "browser", label: "通过浏览器登录 Z.ai OAuth" },
      { id: "apikey", label: "手动输入 Z.ai API Key / Token" },
    ],
  });
  if (!choice) throw new Error("已取消登录");
  if (choice === "desktop") return loginDesktop(callbacks);
  if (choice === "browser") return loginBrowser(callbacks);
  return loginApiKey(callbacks);
}

async function loginDesktop(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("正在读取本机 ZCode 客户端登录凭证...");
  const account = await loadDesktopAccount(callbacks.signal);
  callbacks.onProgress?.(account.name ? `已连接 ${account.name}` : "已连接本机 ZCode 账号");
  return credentialFromAccount(account);
}

async function loginBrowser(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const providerChoice = await callbacks.onSelect({
    message: "选择账号类型",
    options: [
      { id: "zai", label: "Z.ai (推荐，对应 ZCode Start Plan)" },
      { id: "bigmodel", label: "BigModel (智谱开放平台)" },
    ],
  });
  const provider = providerChoice === "bigmodel" ? "bigmodel" : "zai";
  const flow = await startBrowserLogin(provider, callbacks.signal);
  callbacks.onAuth({
    url: flow.authorizeUrl,
    instructions: "请在打开的浏览器中完成登录与授权。完成后回到此处，插件将自动检测并同步。",
  });
  openBrowser(flow.authorizeUrl);
  while (Date.now() < flow.expiresAt) {
    callbacks.signal?.throwIfAborted();
    const result = await pollBrowserLogin(flow.pollUrl, flow.pollToken, callbacks.signal);
    if (result.status === "failed") throw new Error("浏览器登录失败");
    if (result.status === "ready" && result.jwt) {
      return {
        refresh: result.accessToken || result.jwt,
        access: result.jwt,
        expires: Date.now() + 14 * 24 * 60 * 60 * 1000,
        mode: "zcode-plan",
        accountName: result.name,
        userId: result.userId,
        providerFamily: provider,
      };
    }
    callbacks.onProgress?.("等待浏览器授权完成...");
    await delay(flow.intervalMs, callbacks.signal);
  }
  throw new Error("登录超时，请重试");
}

async function loginApiKey(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const key = (
    await callbacks.onPrompt({
      message: "输入 Z.ai API Key 或 ZCode Token",
      placeholder: "粘贴 API Key 或 JWT Token",
    })
  ).trim();
  if (!key) throw new Error("未输入有效凭证");
  if (isJwt(key)) {
    return {
      refresh: key,
      access: key,
      expires: Date.now() + 14 * 24 * 60 * 60 * 1000,
      mode: "zcode-plan",
    };
  }
  await fetchPublicModels(key, callbacks.signal);
  return {
    refresh: key,
    access: key,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    mode: "api-key",
  };
}

function credentialFromAccount(account: Awaited<ReturnType<typeof loadDesktopAccount>>): OAuthCredentials {
  return {
    refresh: account.accessToken || account.jwt,
    access: account.jwt,
    expires: Date.now() + 14 * 24 * 60 * 60 * 1000,
    mode: "zcode-plan",
    accountName: account.name,
    userId: account.userId,
    providerFamily: account.provider,
  };
}

async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
  if (credentials.mode === "api-key") {
    return { ...credentials, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
  }
  try {
    await fetchPlanBalance(credentials.access, signal);
    return { ...credentials, expires: Date.now() + 14 * 24 * 60 * 60 * 1000 };
  } catch {
    const account = await loadDesktopAccount(signal);
    return credentialFromAccount(account);
  }
}

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // URL remains visible in instructions
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("已取消"));
    }, { once: true });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("zcode", {
    name: "ZCode",
    baseUrl: PLAN_ANTHROPIC_BASE,
    apiKey: "$ZCODE_API_KEY",
    api: "anthropic-messages",
    models: [
      toProviderModel(catalogModel("glm-5.3-flash")),
      toProviderModel(catalogModel("glm-5.3")),
    ],
    oauth: {
      name: "ZCode",
      isSubscription: true,
      login,
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    },
    refreshModels: async (context) => {
      const key =
        context.credential && "key" in context.credential
          ? context.credential.key
          : context.credential && "access" in context.credential
          ? context.credential.access
          : undefined;
      if (!key || !context.allowNetwork) {
        return [
          toProviderModel(catalogModel("glm-5.3-flash")),
          toProviderModel(catalogModel("glm-5.3")),
        ];
      }
      return discoverModels(key, context.signal);
    },
    streamSimple: streamZcode,
  });

  pi.registerCommand("zcode", {
    description: "查看 ZCode 账号状态、额度，或切换模型",
    getArgumentCompletions: (prefix) => [
      { label: "status", value: "status" },
      { label: "models", value: "models" },
      { label: "use", value: "use " },
      { label: "sync", value: "sync" },
    ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      if (command === "models" || command === "use") {
        await selectModel(pi, ctx, rest.join(" "));
        return;
      }
      if (command === "sync") {
        try {
          const acc = await loadDesktopAccount();
          ctx.ui.notify(`已同步本地 ZCode 账号: ${acc.name || "已连接"} (${acc.plans.map(p => p.name).join(", ")})`, "info");
        } catch (e: any) {
          ctx.ui.notify(e.message, "error");
        }
        return;
      }
      await showStatus(ctx);
    },
  });

  // Background status bar update
  (async () => {
    try {
      const account = await loadDesktopAccount();
      if (account.jwt) {
        const flash = account.models.find((m) => m.id.includes("flash"));
        const main = account.models.find((m) => !m.id.includes("flash"));
        const flashText = flash?.remaining ? `Flash ${(flash.remaining / 1_000_000).toFixed(1)}M` : "Flash";
        const mainText = main?.remaining ? `GLM ${(main.remaining / 1_000_000).toFixed(1)}M` : "GLM";
        pi.events?.emit?.("zcode:quota", { flash, main });
      }
    } catch {
      // Ignore background init failure
    }
  })();
}

async function showStatus(ctx: {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void; setStatus?(key: string, text?: string): void };
  modelRegistry: { getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string } } | undefined> };
}) {
  let key: string | undefined;
  try {
    const auth = await ctx.modelRegistry.getProviderAuth("zcode");
    key = auth?.auth?.apiKey;
  } catch {
    // Ignore
  }

  // Fallback to desktop account if not explicitly logged in via pi
  if (!key) {
    try {
      const desktop = await loadDesktopAccount();
      key = desktop.jwt;
    } catch {
      ctx.ui.notify("还没有登录 ZCode。运行 /login zcode 或打开 ZCode 桌面端登录。", "warning");
      return;
    }
  }

  try {
    const balance = await fetchPlanBalance(key);

    const planSections: string[] = [];
    for (const plan of balance.detailedPlans) {
      if (plan.status.toLowerCase() !== "active") continue;
      const endsText = plan.endsAt
        ? ` (到期: ${new Date(plan.endsAt * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })})`
        : "";
      const isWeekend = plan.planId.includes("1010") || plan.name.includes("Weekend");
      const icon = isWeekend ? "🎉" : "⚡";
      const modelLines = plan.balances.map((b) => {
        const percent = b.total > 0 ? ((b.remaining / b.total) * 100).toFixed(1) + "%" : "100%";
        const remStr = (b.remaining / 1_000_000).toFixed(2) + "M";
        const totStr = (b.total / 1_000_000).toFixed(2) + "M";
        return `  • ${b.name}: ${remStr} / ${totStr} (剩余 ${percent})`;
      }).join("\n");
      planSections.push(`${icon} 【${plan.name}】${endsText}\n${modelLines}`);
    }

    const totalLines = balance.models.map((m) => {
      const remStr = ((m.remaining ?? 0) / 1_000_000).toFixed(2) + "M";
      const totStr = ((m.total ?? 0) / 1_000_000).toFixed(2) + "M";
      return `• ${m.name} 累计可用: ${remStr} / ${totStr}`;
    }).join("\n");

    const summary =
      `【ZCode 套餐与额度状态】\n\n` +
      planSections.join("\n\n") +
      `\n\n【总可用额度合计】\n${totalLines}\n\n` +
      `切换模型: 运行 /zcode models 或 /model zcode/glm-5.3-flash`;
    ctx.ui.notify(summary, "info");

    const flash = balance.models.find((m) => m.id.includes("flash"));
    const main = balance.models.find((m) => !m.id.includes("flash"));
    if (ctx.ui.setStatus) {
      const flashStr = flash?.remaining ? `Flash ${(flash.remaining / 1_000_000).toFixed(0)}M` : "Flash";
      const mainStr = main?.remaining ? `GLM ${(main.remaining / 1_000_000).toFixed(1)}M` : "GLM";
      ctx.ui.setStatus("zcode", `⚡ ZCode: ${flashStr} | ${mainStr}`);
    }
  } catch (error: any) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function selectModel(
  pi: ExtensionAPI,
  ctx: {
    ui: {
      select(title: string, options: string[]): Promise<string | undefined>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
    modelRegistry: {
      find(provider: string, id: string): Model<any> | undefined;
      getAll(): Model<any>[];
    };
  },
  requested: string
) {
  const models = ctx.modelRegistry.getAll().filter((model) => model.provider === "zcode");
  if (!models.length) {
    ctx.ui.notify("没有可用的 ZCode 模型。请先运行 /login zcode", "warning");
    return;
  }
  const requestedId = requested.trim().toLowerCase();
  const chosen = requestedId
    ? models.find((model) => model.id === requestedId || model.name.toLowerCase().includes(requestedId))
    : undefined;

  const displayOptions = models.map((m) => {
    const isFlash = m.id.includes("flash");
    const desc = isFlash ? "（推荐，极速响应，代码与通用任务）" : "（强推理，复杂逻辑与长文分析）";
    return `${m.name} ${desc}  [${m.id}]`;
  });

  const label = chosen
    ? chosen.id
    : await ctx.ui.select("选择要使用的 ZCode 模型", displayOptions);
  if (!label) return;

  const model = chosen ?? models.find((item) => label.includes(`[${item.id}]`) || label.includes(item.id));
  if (!model) {
    ctx.ui.notify("找不到模型 " + requested, "error");
    return;
  }
  const ok = await pi.setModel(model);
  ctx.ui.notify(ok ? `已切换到 ${model.name}` : "切换模型失败", ok ? "info" : "error");
}
