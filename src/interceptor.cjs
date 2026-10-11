const { cleanGlmRequestBody, isGlmPromptRequest } = require("./clean-glm-prompt.cjs");

const origFetch = globalThis.fetch;

function bodyText(body) {
  if (typeof body === "string") return body;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return null;
}

function updateContentLength(headers, body) {
  if (!headers) return;
  const length = String(Buffer.byteLength(body));
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    if (headers.has("content-length")) headers.set("content-length", length);
    return;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (String(pair?.[0]).toLowerCase() === "content-length") pair[1] = length;
    }
    return;
  }
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-length") headers[key] = length;
    }
  }
}

if (origFetch) {
  globalThis.fetch = async function (input, init) {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url || String(input);
    if (isGlmPromptRequest(url) && init?.body) {
      const raw = bodyText(init.body);
      if (raw) {
        try {
          const data = JSON.parse(raw);
          const cleaned = cleanGlmRequestBody(data);
          if (cleaned.changed) {
            const next = JSON.stringify(data);
            init.body = next;
            updateContentLength(init.headers, next);
          }
        } catch {
          // Keep the original body when it is not a JSON prompt payload.
        }
      }
    }
    return origFetch.apply(this, arguments);
  };
}
