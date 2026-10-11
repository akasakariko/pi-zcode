# pi-zcode

在 **pi** 里直接使用 **ZCode** 账号及 **Start Plan** 专属模型（GLM-5.3-Flash 与 GLM-5.3）。

通过原生后台桥接（ZCode Native Protocol Bridge），免去繁琐配置，完美绕过云端 WAF 限制，实现流式输出与思考过程（Thinking Tokens）实时展示。

---

## 特性

- ⚡ **全额支持 Start Plan 与 Weekend Build 活动套餐**：自动识别并汇聚你的所有有效套餐，包括周末专属 **Weekend Build 3亿 Token（300M）** 超大活动配额与日常 **Start Plan** 配额（总计超 305M Token）。
- 🔑 **自动同步登录**：自动识别 macOS 本地已登录的 ZCode 桌面端账号凭证，无需重复输入密码。
- 🌐 **多方式登录**：支持本地客户端同步、浏览器 OAuth 授权登录、以及手动配置。
- 🧠 **支持深度思考（Reasoning）**：完整保留模型的思考流，支持调整思考深度（low / high / max）。
- 📊 **额度实时查看**：输入 `/zcode` 即可随时查看今日模型剩余额度与配额使用率。
- 🔄 **智能并发重试**：针对 Start Plan 的并发限制，自动排队重试，防止突发报错。

---

## 支持的模型

| 模型 ID | 模型全称 | 上下文 | 最大输出 | 思考/推理 | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `zcode/glm-5.3-flash` | GLM-5.3-Flash | 1,000,000 | 128,000 | ✅ 支持 | 极速响应，推荐日常编码与快速对话 |
| `zcode/glm-5.3` | GLM-5.3 | 1,000,000 | 128,000 | ✅ 支持 | 旗舰超强大模型，长文理解与复杂架构设计 |

---

## 使用指南

### 1. 登录账号

插件已默认自动读取本机已登录的 ZCode 客户端凭证。如果需要重新登录或切换账号：

在 pi 中运行命令：
```text
/login zcode
```
可选择：
1. **使用本机已经登录的 ZCode 客户端账号**（推荐，一键同步）
2. **通过浏览器登录 Z.ai OAuth**
3. **手动输入 API Key / Token**

### 2. 选择模型开始对话

你可以通过以下几种方式切换到 ZCode 模型：

- 使用快捷命令选择：
  ```text
  /zcode models
  ```
- 使用 pi 原生切换命令：
  ```text
  /model zcode/glm-5.3-flash
  /model zcode/glm-5.3
  ```
- 命令行直接启动：
  ```bash
  pi --model zcode/glm-5.3-flash
  ```

### 3. 查看额度与状态

在会话中输入：
```text
/zcode
```
将展示类似如下信息：
```text
【ZCode 套餐状态】
当前套餐: ZCode Start Plan
今日可用额度:
• GLM-5.3-Flash 剩余 4.98M / 5.00M
• GLM-5.3 剩余 3.00M / 3.00M

切换模型: 运行 /zcode models 或 /model zcode/glm-5.3-flash
```

---

## 技术架构

ZCode Start Plan 的服务端对话接口受到客户端环境与安全验证保护。本插件通过内置的 `ZCodeBridge`：
1. 启动轻量级本地 ZCode 官方协议宿主 (`app-server`)；
2. 自动注入安全验证握手与 Start Plan 凭证；
3. 将 Pi 的上下文转译后以 SSE 流式实时接收 `reasoning_delta`（思考过程）和 `text_delta`（生成文本）；
4. 提供空闲自动解绑与进程生命周期管理，单次命令模式与交互模式均能平滑退出。
5. 请求 GLM 前清洗 ZCode 注入的人设、Harness 规则和 `system-reminder`。这不是再追加一段“忽略前文”的覆盖指令；Pi 自己的系统提示留在对话内容里。
