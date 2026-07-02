import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_CONTROL_PLANE_URL = "https://uat.mundusx.ai";
const DEFAULT_MODEL = "Qwen/Qwen2.5-1.5B-Instruct";
const DEFAULT_TIMEOUT_SECONDS = 90;
const POLL_INTERVAL_MS = 1500;
const MAX_BODY_BYTES = 64 * 1024;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = resolve(MODULE_DIR, "../public/mundusx-logo.png");

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? "3002"),
    controlPlaneUrl: normalizeOrigin(env.MUNDUSX_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL),
    operatorToken: (env.MUNDUSX_OPERATOR_TOKEN ?? env.OPENGPU_OPERATOR_TOKEN ?? "").trim(),
    defaultModel: (env.MUNDUSX_CHAT_DEFAULT_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    defaultTimeoutSeconds: positiveInteger(
      env.MUNDUSX_CHAT_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
    ),
  };
}

export function page(config = configFromEnv()) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MundusX Chat</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #06080d;
      --rail: #0b111a;
      --surface: #111821;
      --surface-2: #151e29;
      --line: #202b38;
      --line-strong: #2b3a4d;
      --text: #f4f7fb;
      --muted: #a8b3c2;
      --soft: #cbd5e1;
      --blue: #3da6ff;
      --green: #42d392;
      --red: #ff6b7a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
    }
    aside {
      height: 100vh;
      border-right: 1px solid var(--line);
      padding: 14px;
      background: var(--rail);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 14px;
    }
    .new-chat {
      width: 100%;
      height: 44px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      color: var(--text);
      background: #0f1722;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 10px;
      padding: 0 12px;
      font-weight: 650;
    }
    .rail-list {
      min-height: 0;
      overflow: auto;
      display: grid;
      align-content: start;
      gap: 6px;
    }
    .history-item {
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--soft);
      background: transparent;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .history-item.active {
      background: #151f2c;
      color: var(--text);
    }
    .rail-footer {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      display: grid;
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-weight: 800;
    }
    .brand-logo {
      width: 34px;
      height: 34px;
      object-fit: contain;
      flex: 0 0 auto;
    }
    main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      height: 100vh;
      background: var(--bg);
    }
    header {
      height: 58px;
      padding: 0 22px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .chat-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 750;
    }
    .model-pill {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--muted);
      font-size: 15px;
      background: #0c121b;
    }
    .status {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--muted);
      white-space: nowrap;
      background: #0c121b;
      font-size: 14px;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--green);
      margin-right: 8px;
    }
    .messages {
      padding: 0;
      overflow: auto;
    }
    .conversation {
      width: min(880px, 100%);
      margin: 0 auto;
      padding: 38px 18px 28px;
      display: grid;
      gap: 8px;
    }
    .welcome {
      min-height: 38vh;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--text);
    }
    .welcome-inner {
      width: min(680px, 100%);
      display: grid;
      gap: 18px;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 5vw, 42px);
      line-height: 1.08;
      letter-spacing: 0;
      font-weight: 780;
    }
    .suggestions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 4px;
    }
    .suggestion {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 14px;
      background: #0c121b;
      color: var(--soft);
      text-align: left;
      font-size: 14px;
      line-height: 1.35;
    }
    .message {
      width: 100%;
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 14px;
      padding: 18px 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
    }
    .avatar {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--surface-2);
      color: var(--text);
      font-weight: 750;
      flex: 0 0 auto;
    }
    .message-body {
      min-width: 0;
      color: var(--text);
      padding-top: 4px;
    }
    .message.user {
      border-bottom: 1px solid transparent;
    }
    .message.user .avatar { background: #23405f; }
    .message.error {
      color: #ffd9dd;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      margin-top: 8px;
    }
    form {
      width: min(880px, 100%);
      margin: 0 auto;
      padding: 14px 18px 24px;
    }
    .composer {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 10px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
    }
    textarea {
      min-height: 52px;
      max-height: 180px;
      resize: none;
      border: 0;
      padding: 13px 12px;
      color: var(--text);
      background: transparent;
      font: inherit;
      outline: none;
    }
    button {
      width: 44px;
      height: 44px;
      align-self: end;
      border: 1px solid #2f8cd2;
      border-radius: 8px;
      color: #ffffff;
      background: #0b70b9;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    button:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    .new-chat,
    .suggestion {
      width: 100%;
      height: auto;
      display: flex;
      place-items: initial;
      align-self: auto;
    }
    .new-chat {
      height: 44px;
      align-items: center;
    }
    code {
      color: #b9dcff;
      background: #08213a;
      border: 1px solid #164466;
      border-radius: 6px;
      padding: 2px 6px;
    }
    @media (max-width: 820px) {
      .shell { grid-template-columns: 1fr; }
      aside { display: none; }
      main { height: 100vh; }
      header { padding: 0 14px; }
      .suggestions { grid-template-columns: 1fr; }
      .conversation { padding: 24px 14px 20px; }
      form { padding: 12px 14px 18px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <button class="new-chat" type="button"><span>+</span><span>New chat</span></button>
      <div class="rail-list" aria-label="Conversation history">
        <div class="history-item active">New conversation</div>
        <div class="history-item">Honda history draft</div>
        <div class="history-item">GPU node troubleshooting</div>
        <div class="history-item">MundusX architecture</div>
      </div>
      <div class="rail-footer">
        <div class="brand"><img class="brand-logo" src="/assets/mundusx-logo.png" alt="" /><span>MundusX</span></div>
        <div>Connected to <code>${escapeHtml(config.controlPlaneUrl)}</code></div>
      </div>
    </aside>
    <main>
      <header>
        <div class="chat-title">MundusX Chat <span class="model-pill">${escapeHtml(config.defaultModel)}</span></div>
        <div class="status"><span class="dot"></span><span id="runtime-status">Ready</span></div>
      </header>
      <section class="messages" id="messages" aria-live="polite">
        <div class="conversation" id="conversation">
          <div class="welcome" id="welcome">
            <div class="welcome-inner">
              <h1>What can MundusX help with?</h1>
              <div class="suggestions">
                <button class="suggestion" type="button">Give me a detailed history of Honda from its origins to today.</button>
                <button class="suggestion" type="button">Explain why a CUDA node can claim a job and fail.</button>
                <button class="suggestion" type="button">Draft a product description for MundusX contributors.</button>
                <button class="suggestion" type="button">Summarize the current control-plane architecture.</button>
              </div>
              <div class="meta">Default timeout: ${config.defaultTimeoutSeconds}s</div>
            </div>
          </div>
        </div>
      </section>
      <form id="chat-form">
        <div class="composer">
          <textarea id="prompt" name="prompt" placeholder="Message MundusX..." autocomplete="off" required></textarea>
          <button id="send" type="submit" aria-label="Send">&uarr;</button>
        </div>
      </form>
    </main>
  </div>
  <script>
    const form = document.getElementById("chat-form");
    const promptEl = document.getElementById("prompt");
    const sendEl = document.getElementById("send");
    const messagesEl = document.getElementById("conversation");
    const statusEl = document.getElementById("runtime-status");
    const welcomeEl = document.getElementById("welcome");

    function addMessage(text, role, meta) {
      welcomeEl?.remove();
      const node = document.createElement("div");
      node.className = "message" + (role ? " " + role : "");
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = role === "user" ? "You" : "M";
      const body = document.createElement("div");
      body.className = "message-body";
      body.textContent = text;
      if (meta) {
        const metaNode = document.createElement("div");
        metaNode.className = "meta";
        metaNode.textContent = meta;
        body.appendChild(metaNode);
      }
      node.appendChild(avatar);
      node.appendChild(body);
      messagesEl.appendChild(node);
      document.getElementById("messages").scrollTop = document.getElementById("messages").scrollHeight;
      return node;
    }

    document.querySelectorAll(".suggestion").forEach((button) => {
      button.addEventListener("click", () => {
        promptEl.value = button.textContent.trim();
        promptEl.focus();
      });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = promptEl.value.trim();
      if (!message) return;

      addMessage(message, "user");
      promptEl.value = "";
      sendEl.disabled = true;
      statusEl.textContent = "Working";
      const pending = addMessage("Submitting to MundusX...", "", "Queued");

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "chat request failed");
        }
        const body = pending.querySelector(".message-body");
        body.textContent = payload.output || "(empty response)";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = "job " + payload.job_id + " / " + payload.status;
        body.appendChild(meta);
        statusEl.textContent = "Ready";
      } catch (error) {
        pending.className = "message error";
        const body = pending.querySelector(".message-body");
        body.textContent = error.message;
        statusEl.textContent = "Error";
      } finally {
        sendEl.disabled = false;
        promptEl.focus();
      }
    });
  </script>
</body>
</html>`;
}

export function createServerApp(config = configFromEnv()) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        return sendHtml(response, page(config));
      }
      if (request.method === "GET" && url.pathname === "/assets/mundusx-logo.png") {
        return sendPng(response, await readFile(LOGO_PATH));
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          status: "ok",
          control_plane_url: config.controlPlaneUrl,
          default_model: config.defaultModel,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonBody(request);
        const result = await submitChatTurn(body, config);
        return sendJson(response, 200, result);
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const status = error.statusCode ?? 500;
      return sendJson(response, status, { error: error.message ?? "request failed" });
    }
  });
}

export async function submitChatTurn(body, config = configFromEnv(), fetchImpl = fetch) {
  const message = String(body?.message ?? "").trim();
  if (!message) {
    throw httpError(400, "message is required");
  }

  const timeoutSeconds = positiveInteger(body?.timeoutSeconds, config.defaultTimeoutSeconds);
  const model = String(body?.model ?? config.defaultModel).trim() || config.defaultModel;
  const chatResponse = await controlPlaneFetch(
    fetchImpl,
    config,
    "/v1/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: message }],
        max_tokens: positiveInteger(body?.maxTokens, 512),
        temperature: typeof body?.temperature === "number" ? body.temperature : 0.2,
        stream: false,
      }),
    },
  );

  const jobId = chatResponse?.mundusx?.job_id;
  if (!jobId) {
    throw httpError(502, "control plane did not return a job id");
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await controlPlaneFetch(fetchImpl, config, `/v1/jobs/${encodeURIComponent(jobId)}`);
    const job = latest.job ?? latest;
    if (job.status === "completed") {
      return {
        job_id: jobId,
        status: job.status,
        output: job.output ?? "",
        model: job.model ?? model,
        assigned_node_id: job.assigned_node_id ?? null,
      };
    }
    if (job.status === "failed") {
      throw httpError(502, job.error || "MundusX job failed");
    }
    await delay(POLL_INTERVAL_MS);
  }

  const status = latest?.job?.status ?? latest?.status ?? "unknown";
  throw httpError(504, `timed out waiting for job ${jobId} while status was ${status}`);
}

async function controlPlaneFetch(fetchImpl, config, path, init = {}) {
  const headers = {
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(config.operatorToken ? { Authorization: `Bearer ${config.operatorToken}` } : {}),
    ...(init.headers ?? {}),
  };
  const response = await fetchImpl(`${config.controlPlaneUrl}${path}`, { ...init, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw httpError(response.status, payload.error || `control plane returned ${response.status}`);
  }
  return payload;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(httpError(413, "request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(httpError(400, "invalid json body"));
      }
    });
    request.on("error", reject);
  });
}

function sendHtml(response, html) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendPng(response, bytes) {
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  });
  response.end(bytes);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeOrigin(value) {
  return String(value || DEFAULT_CONTROL_PLANE_URL).replace(/\/+$/, "");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = configFromEnv();
  createServerApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(`MundusX chat listening on http://127.0.0.1:${config.port}`);
    console.log(`controlPlaneUrl: ${config.controlPlaneUrl}`);
  });
}
