# pi-zcode

一个 **pi** 扩展包（pi package），让你在 pi 中使用 **ZCode** 账号（Start Plan / Weekend Build 等套餐）以及 Z.ai 的 GLM 模型。

扩展注册了名为 `zcode` 的模型提供方（provider）和 `/zcode` 命令。使用 ZCode 套餐凭证（JWT）时，请求由 pi 直接以 HTTP 流式（SSE）发送到 ZCode Plan 的 Anthropic 兼容接口，不需要启动额外的子进程；使用普通 Z.ai API Key 时，则走 Z.ai 公共 Anthropic 接口。

---

## 功能

- **注册 `zcode` provider**：默认提供 `zcode/glm-5.3-flash` 与 `zcode/glm-5.3`；登录后会根据账号套餐（或公共 API 的 `/v1/models`）刷新可用模型列表。
- **三种登录方式**（`/login zcode`）：
  1. 读取本机 ZCode 桌面端已登录的凭证（`~/.zcode/v2/credentials.json`，自动解密）；
  2. 浏览器 OAuth 登录（可选 Z.ai 或 BigModel 智谱开放平台），自动打开浏览器并轮询授权结果；
  3. 手动输入 Z.ai API Key 或 ZCode JWT Token。
- **未登录时自动回退**：没有在 pi 中登录时，请求和 `/zcode` 状态查询会尝试使用本机 ZCode 桌面端凭证。
- **套餐与额度查询**：`/zcode` 列出所有 active 套餐（含 Weekend Build 等活动套餐）各模型的剩余/总额度、到期时间，以及跨套餐汇总额度，并更新状态栏。
- **流式输出与思考过程**：支持文本、思考（thinking）内容和工具调用（tool use）的流式转发。
- **思考深度**：pi 的推理等级映射为 `low` / `high` / `max`（其他等级按 `max` 处理）。
- **凭证刷新**：Plan 凭证刷新时会校验余额接口，失败则重新读取本机桌面端账号。

## 支持的模型

内置模型目录（`src/account.ts` 中的 `CATALOG`）包含 GLM-5.3、GLM-5.3-Flash、GLM-5.3-FlashX、GLM-5.2、GLM-5.1、GLM-5、GLM-5-Turbo、GLM-4.7、GLM-4.6、GLM-4.5、GLM-4.5-Air、GLM-5V-Turbo、GLM-4.6V、GLM-4.7-Flash 等，实际显示哪些取决于账号套餐。默认两款：

| 模型 ID | 名称 | 上下文 | 最大输出 | 输入 | 思考 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `zcode/glm-5.3-flash` | GLM-5.3-Flash | 1,000,000 | 128,000 | 文本、图片 | ✅ low / high / max |
| `zcode/glm-5.3` | GLM-5.3 | 1,000,000 | 128,000 | 文本 | ✅ low / high / max |

> 注意：通过 ZCode Plan 凭证请求时，模型 ID 含 `flash` 的会发送为 `GLM-5.3-Flash`，其余一律发送为 `GLM-5.3`。费用在 pi 中按 0 计算。

---

## 安装

本仓库是一个 pi package（`package.json` 中声明了 `"pi": { "extensions": ["./extensions/zcode.ts"] }`），以 TypeScript 源码形式由 pi 直接加载。请按 pi 加载扩展包的方式，将本仓库（或其本地克隆）添加为 pi package。

依赖（peer dependencies，由 pi 提供）：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

## 配置

| 项目 | 说明 |
| :--- | :--- |
| `ZCODE_API_KEY` | provider 的 `apiKey` 配置为 `$ZCODE_API_KEY`，可通过该环境变量提供 Key / Token。 |
| `ZCODE_CREDENTIAL_SECRET` | 解密 ZCode 桌面端凭证时使用的密钥；未设置时使用基于平台、home 目录和用户名的默认值。 |
| `~/.zcode/v2/credentials.json` | ZCode 桌面端凭证文件（桌面登录方式读取）。 |
| `~/.zcode/v2/telemetry-state.json` | 读取其中的 `deviceMid` 作为设备 ID（不存在则随机生成）。 |

凭证类型判断：以 `eyJ` 开头的三段式 JWT 视为 ZCode Plan 凭证；其他视为 Z.ai 公共 API Key。

使用的接口：

- Plan 对话：`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`
- Plan 额度：`https://zcode.z.ai/api/v1/zcode-plan/billing/balance`
- 浏览器登录：`https://zcode.z.ai/api/v1/oauth/cli/init`、`/api/v1/oauth/cli/poll/<flow_id>`
- 公共 API：`https://api.z.ai/api/anthropic`

---

## 使用

### 登录

```text
/login zcode
```

### 切换模型

```text
/zcode models          # 交互选择 ZCode 模型
/zcode use glm-5.3     # 按 ID 或名称直接切换
/model zcode/glm-5.3-flash
```

或启动时指定：

```bash
pi --model zcode/glm-5.3-flash
```

### 查看状态与额度

```text
/zcode          # 或 /zcode status
```

输出包括每个 active 套餐的各模型剩余/总额度与百分比、到期时间，以及"总可用额度合计"。

### 同步本机桌面端账号

```text
/zcode sync
```

读取本机 ZCode 桌面端账号并显示账号名与套餐。

---

## 项目结构

```text
extensions/zcode.ts        # pi 扩展入口：注册 zcode provider、登录流程、/zcode 命令
src/account.ts             # 模型目录、桌面端凭证解密、套餐额度查询、浏览器 OAuth、公共模型列表
src/direct-client.ts       # 将 pi 上下文转换为 Anthropic Messages 格式，直连 ZCode Plan 接口并解析 SSE 流
src/prompt-cache.ts        # 请求时前置的系统提示前缀（ZAI_CACHE_PREFIX）
src/bridge.ts              # 旧的 ZCode app-server 子进程桥接（ZCodeBridge），当前扩展未引用
scripts/check-account.ts   # 打印本机 ZCode 账号、套餐与额度（不输出凭证本身）
scripts/check-account.mjs  # 同上
scripts/save-desktop-login.ts  # 将本机桌面端凭证写入 ~/.pi/agent/auth.json 的 zcode 条目
```

## 开发

`package.json` 中没有定义构建、测试或 lint 脚本，仓库也没有测试文件。辅助脚本是 TypeScript，需要使用能直接运行 `.ts` 的运行时，例如：

```bash
node scripts/check-account.ts          # Node.js 需支持 TypeScript 类型剥离
node scripts/save-desktop-login.ts     # 会修改 ~/.pi/agent/auth.json
```

这两个脚本都需要本机已登录 ZCode 桌面端。

## 许可证

[MIT](./LICENSE) © 2026 KayanoLiam
