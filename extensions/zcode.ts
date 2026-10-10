import { spawn } from "node:child_process";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type Message,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
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
import { ZCodeBridge } from "../src/bridge.ts";

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

function formatMessageContent(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block: any) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return `[思考过程: ${block.thinking}]`;
        if (block.type === "toolCall") {
          return `[调用工具: ${block.name}(${JSON.stringify(block.arguments)})]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function formatTranscriptPrompt(context: TranscriptContext): string {
  const transcript = collapseSystemMessages(context);
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  const parts: string[] = [];

  if (systemPrompt && systemPrompt.trim()) {
    parts.push(`[系统设定与任务指引]\n${systemPrompt.trim()}`);
  }

  const messages = transcript.messages.filter((m) => m.role !== "system");

  if (messages.length === 1 && messages[0].role === "user") {
    const userContent = formatMessageContent(messages[0]);
    if (parts.length > 0) {
      return `${parts.join("\n\n")}\n\n[用户需求]\n${userContent}`;
    }
    return userContent;
  }

  if (messages.length > 0) {
    parts.push("[对话历史记录]");
    for (let i = 0; i < messages.length - 1; i++) {
      const m = messages[i];
      const roleLabel = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具输出";
      parts.push(`${roleLabel}: ${formatMessageContent(m)}`);
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "user") {
      parts.push(`[当前用户提问]\n${formatMessageContent(lastMsg)}`);
    } else {
      const roleLabel = lastMsg.role === "assistant" ? "助手" : "工具输出";
      parts.push(`${roleLabel}: ${formatMessageContent(lastMsg)}`);
    }
  }

  return parts.join("\n\n");
}

function streamZcode(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  let apiKey = options?.apiKey;

  // Fallback to auto-detecting desktop credentials if apiKey was not explicitly set
  if (!apiKey) {
    try {
      const desktop = loadDesktopAccount();
      // loadDesktopAccount is async in signature but creds can be read
      // We will let streamZcodeBridge load it
    } catch {
      // Ignore
    }
  }

  // If using public API Key (e.g. key.secret format), route through public Anthropic endpoint
  if (apiKey && !isJwt(apiKey)) {
    return anthropicMessagesApi().streamSimple(
      { ...model, baseUrl: PUBLIC_ANTHROPIC_BASE } as Model<"anthropic-messages">,
      context,
      options
    );
  }

  // Otherwise, use ZCodeBridge (native app-server execution for Start Plan)
  return streamZcodeBridge(model, context, options, apiKey);
}

function streamZcodeBridge(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  jwt?: string
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const bridge = ZCodeBridge.getInstance();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  const prompt = formatTranscriptPrompt(context);

  (async () => {
    try {
      if (jwt) {
        bridge.setJwt(jwt);
      }

      await options?.onPayload?.(prompt);

      stream.push({ type: "start", partial: output });

      let thinkingBlock: (ThinkingContent & { index: number }) | null = null;
      let textBlock: (TextContent & { index: number }) | null = null;

      const reasoningLevel =
        options?.reasoning === "low"
          ? "low"
          : options?.reasoning === "high"
          ? "high"
          : "max";

      const result = await bridge.streamTurn({
        modelId: model.id,
        prompt,
        reasoningLevel,
        signal: options?.signal,
        onThinkingStart: () => {
          thinkingBlock = {
            type: "thinking",
            thinking: "",
            thinkingSignature: "",
            index: output.content.length,
          };
          output.content.push(thinkingBlock);
          stream.push({
            type: "thinking_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        },
        onThinkingDelta: (delta) => {
          if (!thinkingBlock) {
            thinkingBlock = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: output.content.length,
            };
            output.content.push(thinkingBlock);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
          thinkingBlock.thinking += delta;
          const idx = output.content.indexOf(thinkingBlock);
          stream.push({
            type: "thinking_delta",
            contentIndex: idx,
            delta,
            partial: output,
          });
        },
        onThinkingEnd: (content) => {
          if (thinkingBlock) {
            thinkingBlock.thinking = content;
            const idx = output.content.indexOf(thinkingBlock);
            stream.push({
              type: "thinking_end",
              contentIndex: idx,
              content,
              partial: output,
            });
          }
        },
        onTextStart: () => {
          textBlock = {
            type: "text",
            text: "",
            index: output.content.length,
          };
          output.content.push(textBlock);
          stream.push({
            type: "text_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        },
        onTextDelta: (delta) => {
          if (!textBlock) {
            textBlock = {
              type: "text",
              text: "",
              index: output.content.length,
            };
            output.content.push(textBlock);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
          textBlock.text += delta;
          const idx = output.content.indexOf(textBlock);
          stream.push({
            type: "text_delta",
            contentIndex: idx,
            delta,
            partial: output,
          });
        },
        onTextEnd: (content) => {
          if (textBlock) {
            textBlock.text = content;
            const idx = output.content.indexOf(textBlock);
            stream.push({
              type: "text_end",
              contentIndex: idx,
              content,
              partial: output,
            });
          }
        },
      });

      output.stopReason = "stop";
      if (result.usage) {
        output.usage.input = result.usage.inputTokens ?? 0;
        output.usage.output = result.usage.outputTokens ?? 0;
        output.usage.totalTokens = result.usage.totalTokens ?? 0;
        output.usage.cacheRead = result.usage.cacheReadTokens ?? 0;
        output.usage.cacheWrite = result.usage.cacheWriteTokens ?? 0;
        calculateCost(model, output.usage);
      }

      stream.push({
        type: "done",
        reason: "stop",
        message: output,
      });
    } catch (err: any) {
      const isAborted = options?.signal?.aborted || err?.name === "AbortError";
      output.stopReason = isAborted ? "aborted" : "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
    }
  })();

  return stream;
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
