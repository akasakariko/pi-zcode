import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { loadDesktopAccount, type ZCodeAccount } from "./account.ts";

const DEFAULT_APP_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DEFAULT_CONFIG_PROVIDER_DIR = "/Applications/ZCode.app/Contents/Resources/config/provider";

export interface ZCodeStreamCallbacks {
  onThinkingStart?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onThinkingEnd?: (content: string) => void;
  onTextStart?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: (content: string) => void;
}

export interface ZCodeTurnOptions extends ZCodeStreamCallbacks {
  modelId: string;
  prompt: string;
  reasoningLevel?: "low" | "high" | "max" | "disabled";
  signal?: AbortSignal;
}

export interface ZCodeTurnResult {
  text: string;
  thinking: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export class ZCodeBridge {
  private static instance: ZCodeBridge | null = null;

  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private reqId = 1;
  private pendingRequests = new Map<string, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private account: ZCodeAccount | null = null;
  private readyPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeStreams = new Map<string, {
    callbacks: ZCodeStreamCallbacks;
    resolve: (res: ZCodeTurnResult) => void;
    reject: (err: any) => void;
    fullText: string;
    fullThinking: string;
    thinkingStarted: boolean;
    textStarted: boolean;
  }>();

  public static getInstance(): ZCodeBridge {
    if (!ZCodeBridge.instance) {
      ZCodeBridge.instance = new ZCodeBridge();
    }
    return ZCodeBridge.instance;
  }

  public setAccount(account: ZCodeAccount): void {
    this.account = account;
  }

  public setJwt(jwt: string): void {
    if (this.account) {
      this.account.jwt = jwt;
    } else {
      this.account = {
        provider: "zai",
        jwt,
        plans: [],
        models: [],
      };
    }
  }

  private resolveZCodePath(): string {
    const custom = process.env.ZCODE_CLI_PATH;
    if (custom && existsSync(custom)) return custom;
    if (existsSync(DEFAULT_APP_PATH)) {
      // Ensure provider symlink exists inside glm/
      const glmProviderDir = join(dirname(DEFAULT_APP_PATH), "provider");
      if (!existsSync(glmProviderDir) && existsSync(DEFAULT_CONFIG_PROVIDER_DIR)) {
        try {
          symlinkSync(DEFAULT_CONFIG_PROVIDER_DIR, glmProviderDir);
        } catch {
          // Ignore if already created or permission denied
        }
      }
      return DEFAULT_APP_PATH;
    }
    throw new Error(
      "未找到 ZCode 运行时。请确认已安装 ZCode 桌面端（/Applications/ZCode.app），或设置环境变量 ZCODE_CLI_PATH。"
    );
  }

  public async init(signal?: AbortSignal): Promise<void> {
    if (this.proc && !this.proc.killed) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      try {
        if (!this.account?.jwt) {
          try {
            this.account = await loadDesktopAccount(signal);
          } catch {
            // Keep going if account will be set via jwt
          }
        }
        if (!this.account?.jwt) {
          throw new Error("还没有登录 ZCode。请在 ZCode 桌面端登录或运行 /login zcode。");
        }

        const zcodeBin = this.resolveZCodePath();

        this.proc = spawn("node", [zcodeBin, "app-server", "--stdio"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            GLM_BINARY_PATH: zcodeBin,
          },
        });

        this.rl = readline.createInterface({ input: this.proc.stdout! });
        this.proc.stderr?.on("data", () => {});

        this.proc.on("exit", (code) => {
          this.proc = null;
          this.rl = null;
          this.readyPromise = null;
          for (const [, req] of this.pendingRequests) {
            req.reject(new Error(`ZCode 进程意外退出（exit code: ${code}）`));
          }
          this.pendingRequests.clear();
          for (const [, stream] of this.activeStreams) {
            stream.reject(new Error(`ZCode 进程意外退出（exit code: ${code}）`));
          }
          this.activeStreams.clear();
        });

        process.on("exit", () => this.destroy());

        this.rl.on("line", (line) => this.handleLine(line));

        // Wait a short moment for storageState checks
        await new Promise((r) => setTimeout(r, 600));

        const builtinRevision = "zcode-builtin:30:3cd651c2da600e23913511d95e9cfd962ab782b8622aad8355a506e374dfdee5";

        const providersPayload = {
          "account:zai-individual-coding-plan": { access: { type: "zhipu-account", entitled: false } },
          "account:zai-team-coding-plan": { access: { type: "zhipu-account", entitled: false } },
          "account:zai-start-plan": {
            access: { type: "zhipu-account", entitled: true },
            builtinModelIds: ["GLM-5.3-Flash", "GLM-5.3"],
          },
          "account:bigmodel-individual-coding-plan": { access: { type: "zhipu-account", entitled: false } },
          "account:bigmodel-team-coding-plan": { access: { type: "zhipu-account", entitled: false } },
          "account:bigmodel-start-plan": { access: { type: "zhipu-account", entitled: false } },
          "account:zai-offpeak-idle-plan": { access: { type: "zhipu-account", entitled: false } },
          "account:bigmodel-offpeak-idle-plan": { access: { type: "zhipu-account", entitled: false } },
        };

        const statesPayload = {
          "account:zai-start-plan": {
            availability: "available",
            entitled: true,
            current: true,
            connectionKey: "554edf55f96ce49d9e8ac5bc83c5088f0f4c9ea35e6a42edaba85aa0a445e02c",
          },
          "account:zai-individual-coding-plan": {
            availability: "unavailable",
            entitled: false,
            unavailableReason: "not-entitled",
            current: true,
            connectionKey: "947cf00eb55f9bf10bd97f7e55a657e8e56b20f4626a02aa33e65b45a0076691",
          },
        };

        const revisionStr = `account:[${JSON.stringify(builtinRevision)},${JSON.stringify(
          Object.entries(providersPayload).map(([providerId, config]) => ({ providerId, config }))
        )},${JSON.stringify(statesPayload)}]`;

        await this.send("provider/updateAccountConfig", {
          revision: revisionStr,
          basedOnZCodeBuiltinRevision: builtinRevision,
          providers: providersPayload,
          states: statesPayload,
        });

        this.scheduleIdleUnref();
      } catch (err) {
        this.proc?.kill();
        this.proc = null;
        this.readyPromise = null;
        throw err;
      }
    })();

    return this.readyPromise;
  }

  private send<T = any>(method: string, params: any): Promise<T> {
    const id = "req-" + (this.reqId++);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      if (!this.proc?.stdin?.writable) {
        reject(new Error("ZCode 进程未就绪"));
        return;
      }
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private respond(id: string, result: any): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify({ id, result }) + "\n");
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const data = JSON.parse(line);

      // Handle server-to-client queries
      if (data.method === "session/requestRuntimePreferences") {
        this.respond(data.id, {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
        });
        return;
      }

      if (data.method === "interaction/requestProviderRuntimeHeaders") {
        this.respond(data.id, {
          headersApplied: true,
          requestAuth: { apiKey: this.account?.jwt || "" },
        });
        return;
      }

      // Handle responses to our requests
      if (data.id && this.pendingRequests.has(data.id)) {
        const { resolve, reject } = this.pendingRequests.get(data.id)!;
        this.pendingRequests.delete(data.id);
        if (data.error) {
          reject(new Error(data.error.message || "ZCode Protocol RPC 错误"));
        } else {
          resolve(data.result);
        }
        return;
      }

      // Handle streaming session events
      if (data.method === "session/event") {
        const p = data.params;
        const sessionId = p.sessionId;
        const stream = this.activeStreams.get(sessionId);
        if (!stream) return;

        if (p.type === "model.streaming") {
          const payload = p.payload;
          if (payload?.kind === "reasoning_delta") {
            if (!stream.thinkingStarted) {
              stream.thinkingStarted = true;
              stream.callbacks.onThinkingStart?.();
            }
            stream.fullThinking += payload.delta;
            stream.callbacks.onThinkingDelta?.(payload.delta);
          } else if (payload?.kind === "text_delta") {
            if (stream.thinkingStarted && !stream.textStarted) {
              stream.callbacks.onThinkingEnd?.(stream.fullThinking);
            }
            if (!stream.textStarted) {
              stream.textStarted = true;
              stream.callbacks.onTextStart?.();
            }
            stream.fullText += payload.delta;
            stream.callbacks.onTextDelta?.(payload.delta);
          }
        } else if (p.type === "turn.completed") {
          if (stream.thinkingStarted && !stream.textStarted) {
            stream.callbacks.onThinkingEnd?.(stream.fullThinking);
          }
          if (stream.textStarted) {
            stream.callbacks.onTextEnd?.(stream.fullText);
          }
          this.activeStreams.delete(sessionId);
          const usage = p.payload?.usage;
          stream.resolve({
            text: stream.fullText || p.payload?.response || "",
            thinking: stream.fullThinking,
            usage: usage ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
            } : undefined,
          });
        } else if (p.type === "turn.failed") {
          this.activeStreams.delete(sessionId);
          const msg = p.payload?.errorMessage || p.payload?.error?.message || JSON.stringify(p.payload) || "ZCode Turn 执行失败";
          stream.reject(new Error(msg));
        }
      }
    } catch {
      // Ignore unparseable lines
    }
  }

  private scheduleIdleUnref(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.activeStreams.size === 0 && this.pendingRequests.size === 0) {
        this.unrefProcess();
      }
    }, 500);
  }

  private unrefProcess(): void {
    try {
      this.proc?.unref();
      (this.proc?.stdin as any)?.unref?.();
      (this.proc?.stdout as any)?.unref?.();
      (this.proc?.stderr as any)?.unref?.();
    } catch {
      // Ignore
    }
  }

  private refProcess(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      this.proc?.ref();
      (this.proc?.stdin as any)?.ref?.();
      (this.proc?.stdout as any)?.ref?.();
      (this.proc?.stderr as any)?.ref?.();
    } catch {
      // Ignore
    }
  }

  public async streamTurn(options: ZCodeTurnOptions, retryCount = 0): Promise<ZCodeTurnResult> {
    await this.init(options.signal);
    this.refProcess();

    const modelName = options.modelId.toLowerCase().includes("flash") ? "GLM-5.3-Flash" : "GLM-5.3";
    const reasoningLevel = options.reasoningLevel === "low" ? "low" : options.reasoningLevel === "high" ? "high" : "max";

    const createRes = await this.send("session/create", {
      workspace: {
        workspacePath: process.cwd(),
        workspaceKey: process.cwd(),
      },
      model: {
        providerId: "account:zai-start-plan",
        modelId: modelName,
        options: { reasoningLevel },
      },
      thoughtLevel: reasoningLevel,
      toolAllowlist: [],
      titleGenerationEnabled: false,
    });

    const sessionId = createRes?.session?.sessionId;
    if (!sessionId) {
      this.scheduleIdleUnref();
      throw new Error("无法创建 ZCode 交互会话");
    }

    await this.send("session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
    });

    return new Promise<ZCodeTurnResult>((resolve, reject) => {
      const abortHandler = () => {
        this.send("session/stop", { sessionId }).catch(() => {});
        this.activeStreams.delete(sessionId);
        this.scheduleIdleUnref();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };

      if (options.signal?.aborted) {
        abortHandler();
        return;
      }
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      this.activeStreams.set(sessionId, {
        callbacks: options,
        resolve: (res) => {
          options.signal?.removeEventListener("abort", abortHandler);
          this.scheduleIdleUnref();
          resolve(res);
        },
        reject: (err) => {
          options.signal?.removeEventListener("abort", abortHandler);
          this.scheduleIdleUnref();
          reject(err);
        },
        fullText: "",
        fullThinking: "",
        thinkingStarted: false,
        textStarted: false,
      });

      this.send("session/send", {
        sessionId,
        content: options.prompt,
      }).catch((err) => {
        options.signal?.removeEventListener("abort", abortHandler);
        this.activeStreams.delete(sessionId);
        this.scheduleIdleUnref();
        reject(err);
      });
    }).catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (retryCount < 2 && /concurrency limit|rate_limit|busy/i.test(msg) && !options.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 2000));
        return this.streamTurn(options, retryCount + 1);
      }
      throw err;
    });
  }

  public destroy(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.rl = null;
    this.readyPromise = null;
    this.activeStreams.clear();
    this.pendingRequests.clear();
  }
}
