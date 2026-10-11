// Strip ZCode-injected prompt material from a GLM request.
// Pi's own instructions stay in the user transcript. Do not append an override.

const PI_MARKERS = [
  "[系统设定与任务指引]",
  "[用户需求]",
  "[对话历史记录]",
  "[当前用户提问]",
  "[工程行为规范与交付准则]",
];

// Fingerprints taken from ZCode's context builder, not from the user transcript.
const ZCODE_MARKERS = [
  "You are ZCode",
  "interactive ZCode agent",
  "ZCode's tools",
  "ZCode Explore",
  "ZCode CLI",
  "# ZCode Desktop Context",
  "# Harness",
  "file_path:line_number",
  "submit_result",
  "# Working inside a workflow",
  "dynamic workflow run",
  "authorized security testing",
  "# Environment",
  "You have been invoked in the following environment",
  "Primary working directory",
  "gitStatus: This is the git status at the start of the conversation",
  "You are powered by the model named",
  "# Memory",
  "persistent file-based memory",
  "The following skills are available for use with the Skill tool",
  "# agentsMd",
  "Codebase and user instructions are shown below",
  "# currentDate",
  "Today's date is",
  "# Session-specific guidance",
  "# Communicating with the user",
  "# Output Style:",
  "# Context management",
  "Continue working toward the active session goal",
  "Current session goal state",
  "<task-notification>",
  "<subagent-notification>",
  "System Persona & Environment Override",
  "NOT ZCode",
];

const REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
const SYSTEM_ROLES = new Set(["system", "developer"]);

function isPiText(text) {
  return PI_MARKERS.some((marker) => text.includes(marker));
}

function isZcodeText(text) {
  return ZCODE_MARKERS.some((marker) => text.includes(marker));
}

function tidy(text) {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripReminders(text) {
  let removed = false;
  const next = text.replace(REMINDER_RE, (block) => {
    if (!isZcodeText(block) || isPiText(block)) return block;
    removed = true;
    return "";
  });
  return { text: next, removed };
}

function cleanPromptText(text) {
  const original = String(text ?? "");
  const stripped = stripReminders(original);
  let next = tidy(stripped.text);
  let removedZcode = stripped.removed;

  if (!next) return { text: "", removedZcode: removedZcode || isZcodeText(original) };
  if (!isPiText(next)) {
    if (isZcodeText(next)) return { text: "", removedZcode: true };
    return { text: next, removedZcode };
  }

  const start = Math.min(...PI_MARKERS.map((marker) => next.indexOf(marker)).filter((index) => index >= 0));
  const prefix = next.slice(0, start);
  if (prefix.trim() && isZcodeText(prefix)) {
    removedZcode = true;
    next = tidy(next.slice(start));
  }
  return { text: next, removedZcode };
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return null;
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return null;
}

function updateBlockText(block, text) {
  if (typeof block === "string") return text;
  if (typeof block.text === "string") return { ...block, text };
  if (typeof block.content === "string") return { ...block, content: text };
  return block;
}

function cleanBlocks(blocks) {
  let changed = false;
  let removedZcode = false;
  const kept = [];
  for (const block of blocks) {
    const text = blockText(block);
    if (text == null) {
      kept.push(block);
      continue;
    }
    const cleaned = cleanPromptText(text);
    if (cleaned.removedZcode) removedZcode = true;
    if (!cleaned.text) {
      changed = true;
      continue;
    }
    if (cleaned.text !== text) {
      changed = true;
      kept.push(updateBlockText(block, cleaned.text));
    } else {
      kept.push(block);
    }
  }
  if (kept.length !== blocks.length) changed = true;
  return { changed, removedZcode, blocks: kept };
}

function cleanSystemField(system) {
  if (typeof system === "string") {
    const cleaned = cleanPromptText(system);
    if (!cleaned.text) {
      return { changed: true, removedZcode: cleaned.removedZcode, value: undefined };
    }
    return {
      changed: cleaned.text !== system,
      removedZcode: cleaned.removedZcode,
      value: cleaned.text,
    };
  }
  if (!Array.isArray(system)) return { changed: false, removedZcode: false, value: system };
  const cleaned = cleanBlocks(system);
  return {
    changed: cleaned.changed,
    removedZcode: cleaned.removedZcode,
    value: cleaned.blocks.length ? cleaned.blocks : undefined,
  };
}

function cleanMessage(message) {
  if (!message || typeof message !== "object") return { drop: false, changed: false, removedZcode: false, message };
  if (typeof message.content === "string") {
    const cleaned = cleanPromptText(message.content);
    if (!cleaned.text) return { drop: true, changed: true, removedZcode: cleaned.removedZcode, message };
    if (cleaned.text === message.content) {
      return { drop: false, changed: false, removedZcode: cleaned.removedZcode, message };
    }
    return {
      drop: false,
      changed: true,
      removedZcode: cleaned.removedZcode,
      message: { ...message, content: cleaned.text },
    };
  }
  if (Array.isArray(message.content)) {
    const cleaned = cleanBlocks(message.content);
    if (cleaned.blocks.length === 0) {
      return { drop: true, changed: true, removedZcode: cleaned.removedZcode, message };
    }
    if (!cleaned.changed) return { drop: false, changed: false, removedZcode: cleaned.removedZcode, message };
    return {
      drop: false,
      changed: true,
      removedZcode: cleaned.removedZcode,
      message: { ...message, content: cleaned.blocks },
    };
  }
  if (SYSTEM_ROLES.has(message.role) && isZcodeText(JSON.stringify(message))) {
    return { drop: true, changed: true, removedZcode: true, message };
  }
  return { drop: false, changed: false, removedZcode: false, message };
}

function cleanMessages(messages) {
  let changed = false;
  let removedZcode = false;
  const next = [];
  for (const message of messages) {
    const cleaned = cleanMessage(message);
    if (cleaned.removedZcode) removedZcode = true;
    if (cleaned.drop) {
      changed = true;
      continue;
    }
    if (cleaned.changed) changed = true;
    next.push(cleaned.message);
  }
  return { changed, removedZcode, messages: next };
}

function cleanGlmRequestBody(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { changed: false, removedZcode: false };
  let changed = false;
  let removedZcode = false;

  if ("system" in data) {
    const cleaned = cleanSystemField(data.system);
    if (cleaned.removedZcode) removedZcode = true;
    if (cleaned.changed) {
      changed = true;
      if (cleaned.value == null) delete data.system;
      else data.system = cleaned.value;
    }
  }

  if (typeof data.instructions === "string") {
    const cleaned = cleanPromptText(data.instructions);
    if (cleaned.removedZcode) removedZcode = true;
    if (!cleaned.text) {
      delete data.instructions;
      changed = true;
    } else if (cleaned.text !== data.instructions) {
      data.instructions = cleaned.text;
      changed = true;
    }
  }

  for (const key of ["messages", "input"]) {
    if (!Array.isArray(data[key])) continue;
    const cleaned = cleanMessages(data[key]);
    if (cleaned.removedZcode) removedZcode = true;
    if (!cleaned.changed) continue;
    if (cleaned.messages.length === 0) continue;
    data[key] = cleaned.messages;
    changed = true;
  }

  if (removedZcode) {
    for (const key of ["tools", "tool_choice", "toolChoice"]) {
      if (data[key] == null) continue;
      delete data[key];
      changed = true;
    }
  }

  return { changed, removedZcode };
}

function isGlmPromptRequest(url) {
  return /\/(?:messages|chat\/completions|responses)(?:\?|$)/.test(url);
}

module.exports = {
  cleanGlmRequestBody,
  cleanPromptText,
  isGlmPromptRequest,
};

if (require.main === module) {
  const assert = require("node:assert/strict");

  const anthropic = {
    model: "GLM-5.3",
    max_tokens: 128,
    system: [
      { type: "text", text: "You are ZCode, an interactive coding agent", cache_control: { type: "ephemeral" } },
      {
        type: "text",
        text: "You are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges.\n\n# Harness\n- Reference code as `file_path:line_number` — it's clickable.\n- finish by calling `submit_result`.",
      },
      {
        type: "text",
        text: "# Environment\nYou have been invoked in the following environment:\n- Primary working directory: /tmp\n- You are powered by the model named account:zai-start-plan/GLM-5.3.",
      },
      {
        type: "text",
        text: "# System Persona & Environment Override (Highest Precedence)\n- You are an expert coding assistant operating inside pi, NOT ZCode.",
      },
    ],
    messages: [
      {
        role: "user",
        content: "<system-reminder>\nThe following skills are available for use with the Skill tool:\n- foo\n</system-reminder>\n",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\n# agentsMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions.\n</system-reminder>\n\nYou are ZCode, an interactive coding agent\n\n[工程行为规范与交付准则]\n1. 结论先行\n\n[系统设定与任务指引]\nYou are pi.\n\n[用户需求]\nExplain what ZCode is, including the phrase You are ZCode.",
          },
        ],
      },
    ],
    tools: [{ name: "submit_result" }],
    tool_choice: { type: "auto" },
  };

  const cleaned = cleanGlmRequestBody(anthropic);
  assert.equal(cleaned.changed, true);
  assert.equal(cleaned.removedZcode, true);
  assert.equal(anthropic.system, undefined);
  assert.equal(anthropic.tools, undefined);
  assert.equal(anthropic.tool_choice, undefined);
  assert.equal(anthropic.messages.length, 1);
  assert.equal(anthropic.messages[0].content[0].text.includes("[系统设定与任务指引]"), true);
  assert.equal(anthropic.messages[0].content[0].text.includes("Explain what ZCode is"), true);
  assert.equal(anthropic.messages[0].content[0].text.includes("system-reminder"), false);
  assert.equal(anthropic.messages[0].content[0].text.includes("# Harness"), false);
  assert.equal(anthropic.messages[0].content[0].text.startsWith("[工程行为规范与交付准则]"), true);
  assert.equal(JSON.stringify(anthropic).includes("System Persona & Environment Override"), false);

  const untouched = {
    system: [{ type: "text", text: "You are a translator." }],
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "lookup" }],
  };
  const kept = cleanGlmRequestBody(untouched);
  assert.equal(kept.changed, false);
  assert.equal(untouched.system[0].text, "You are a translator.");
  assert.equal(untouched.tools[0].name, "lookup");

  const openai = {
    messages: [
      { role: "system", content: "# Environment\nYou have been invoked in the following environment:" },
      { role: "user", content: "[用户需求]\n继续" },
    ],
    tools: [{ type: "function", function: { name: "escalate" } }],
  };
  cleanGlmRequestBody(openai);
  assert.equal(openai.messages.length, 1);
  assert.equal(openai.messages[0].content, "[用户需求]\n继续");
  assert.equal(openai.tools, undefined);

  assert.equal(isGlmPromptRequest("https://api.z.ai/v1/messages"), true);
  assert.equal(isGlmPromptRequest("https://api.z.ai/v1/messages?beta=true"), true);
  assert.equal(isGlmPromptRequest("https://open.bigmodel.cn/api/paas/v4/chat/completions"), true);
  assert.equal(isGlmPromptRequest("https://api.z.ai/oauth/cli/init"), false);

  const quoted = {
    system: [{ type: "text", text: "# Harness\n- Reference code as `file_path:line_number`." }],
    messages: [
      {
        role: "user",
        content: "[系统设定与任务指引]\n# Environment\nPrimary working directory: /Users/cc\n\n[用户需求]\nkeep this",
      },
    ],
  };
  cleanGlmRequestBody(quoted);
  assert.equal(quoted.system, undefined);
  assert.equal(quoted.messages[0].content.includes("# Environment"), true);
  assert.equal(quoted.messages[0].content.includes("keep this"), true);

  console.log("clean-glm-prompt: ok");
}
