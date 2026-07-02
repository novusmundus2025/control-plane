import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_CONTROL_PLANE_URL = "https://uat.mundusx.ai";
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
    modelOverride: (env.MUNDUSX_CHAT_MODEL ?? env.MUNDUSX_CHAT_DEFAULT_MODEL ?? "").trim(),
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

    .shell {
      grid-template-columns: 360px minmax(0, 1fr);
      border: 4px double #050505;
      background: #f7f7f3;
      font-family: "Courier New", Consolas, "Lucida Console", monospace;
      height: 100vh;
      min-height: 0;
    }
    body {
      overflow: hidden;
      background: #f7f7f3;
      color: #050505;
      font-family: "Courier New", Consolas, "Lucida Console", monospace;
    }
    aside {
      border-right: 4px double #050505;
      padding: 20px;
      background: #020202;
      color: #ffffff;
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      gap: 22px;
      overflow: hidden;
      min-height: 0;
    }
    .brand-block {
      display: grid;
      grid-template-columns: 62px minmax(0, 1fr);
      gap: 16px;
      align-items: center;
      padding: 12px 10px 6px;
    }
    .brand-block .brand-logo {
      width: 58px;
      height: 58px;
      object-fit: contain;
      filter: grayscale(1) brightness(0) invert(1);
    }
    .brand-name {
      font-size: 30px;
      line-height: 1;
      font-weight: 900;
      letter-spacing: 1px;
    }
    .brand-kicker {
      margin-top: 10px;
      color: #c9c9c1;
      font-size: 14px;
      letter-spacing: 1px;
      white-space: nowrap;
    }
    .new-chat {
      min-height: 48px;
      border: 2px solid #ffffff;
      border-radius: 0;
      color: #ffffff;
      background: #050505;
      justify-content: space-between;
      padding: 0 16px;
      font-weight: 800;
      text-transform: uppercase;
      box-shadow: inset 0 0 0 1px #777777;
    }
    .rail-list {
      gap: 14px;
      padding-right: 4px;
    }
    .history-group {
      display: grid;
      gap: 8px;
      border-top: 1px dashed #d6d6d0;
      padding-top: 10px;
    }
    .history-label {
      color: #c9c9c1;
      font-size: 14px;
      text-transform: uppercase;
    }
    .history-item {
      border-radius: 0;
      padding: 9px 10px;
      color: #ffffff;
      font-size: 15px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 82px;
      gap: 10px;
    }
    .history-item span:first-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .history-item.active {
      background: #ffffff;
      color: #000000;
    }
    .history-time {
      color: inherit;
      opacity: 0.78;
      font-size: 13px;
      justify-self: end;
    }
    .rail-footer,
    .account-card {
      border: 2px solid #ffffff;
      padding: 14px;
      color: #ffffff;
      box-shadow: inset 0 0 0 1px #777777;
    }
    .network-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .network-dot {
      width: 12px;
      height: 12px;
      border: 2px solid #ffffff;
      background: #0c8f4e;
      display: inline-block;
      margin-right: 8px;
      vertical-align: -1px;
    }
    .account-card {
      display: grid;
      grid-template-columns: 56px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
    }
    .avatar-chip {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      border: 1px solid #ffffff;
      font-weight: 900;
      font-size: 18px;
    }
    .account-name {
      font-weight: 900;
      text-transform: uppercase;
    }
    .account-role {
      margin-top: 5px;
      color: #c9c9c1;
      font-size: 14px;
      text-transform: uppercase;
    }
    main {
      background: #f7f7f3;
      color: #050505;
      min-height: 0;
    }
    header {
      height: 70px;
      padding: 0 24px;
      border-bottom: 3px double #050505;
      background: #f7f7f3;
    }
    .chat-title {
      color: #050505;
      font-size: 20px;
      font-weight: 900;
    }
    .model-pill {
      display: none;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .status {
      border: 2px dashed #050505;
      border-radius: 0;
      padding: 10px 18px;
      color: #050505;
      background: transparent;
      font-size: 16px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .expand-control {
      color: #050505;
      font-size: 20px;
      font-weight: 900;
    }
    .dot {
      width: 11px;
      height: 11px;
      background: #050505;
      margin-right: 10px;
    }
    .messages {
      background:
        linear-gradient(rgba(0,0,0,0.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,0,0,0.012) 1px, transparent 1px),
        #f7f7f3;
      background-size: 22px 22px;
    }
    .conversation {
      width: min(900px, 100%);
      min-height: 100%;
      padding: 42px 24px 20px;
      align-content: start;
    }
    .welcome {
      color: #050505;
    }
    .welcome-inner {
      width: min(780px, 100%);
      gap: 12px;
      justify-items: center;
    }
    h1 {
      font-size: clamp(28px, 4.4vw, 38px);
      line-height: 1.1;
      letter-spacing: 1px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .welcome-rule {
      width: 22px;
      height: 2px;
      background: #050505;
    }
    .welcome-copy {
      width: min(560px, 100%);
      margin: 0;
      font-size: 18px;
      line-height: 1.45;
    }
    .tip-box {
      border: 2px dotted #050505;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 16px;
      text-align: left;
    }
    .tip-tag {
      background: #050505;
      color: #f7f7f3;
      padding: 3px 8px;
      font-weight: 900;
    }
    .examples-heading {
      width: min(660px, 100%);
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 20px;
      margin-top: 6px;
      color: #050505;
      font-weight: 900;
      text-transform: uppercase;
    }
    .examples-heading::before,
    .examples-heading::after {
      content: "";
      border-top: 2px solid #050505;
    }
    .suggestions {
      width: min(700px, 100%);
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      margin-top: 4px;
    }
    .suggestion {
      border: 0;
      border-radius: 0;
      padding: 0;
      background: transparent;
      color: #050505;
      text-align: left;
      font-size: 16px;
      line-height: 1.4;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 14px;
    }
    .message {
      grid-template-columns: 44px minmax(0, 1fr);
      width: min(900px, 100%);
      margin: 0 auto;
      padding: 14px 0;
    }
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 0;
      border: 2px solid #050505;
      background: #f7f7f3;
      color: #050505;
      font-weight: 900;
    }
    .message-body {
      color: #050505;
      padding: 10px 0 0;
      min-width: 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .message.user .avatar {
      background: #050505;
      color: #f7f7f3;
    }
    .message.error {
      color: #8a0d0d;
    }
    .message.assistant .message-body {
      max-height: min(52vh, 520px);
      overflow: auto;
      border-left: 2px solid #050505;
      padding: 10px 18px;
      background: rgba(255, 255, 255, 0.42);
    }
    form {
      width: min(1120px, calc(100% - 48px));
      padding: 0 0 34px;
      background: #f7f7f3;
      z-index: 2;
    }
    .composer {
      position: relative;
      border: 3px solid #050505;
      border-radius: 0;
      background: #f7f7f3;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto auto;
      gap: 10px 18px;
      padding: 18px 18px 14px;
      box-shadow: inset 0 0 0 2px #f7f7f3, inset 0 0 0 4px #050505;
    }
    .composer::before,
    .composer::after {
      content: "";
      position: absolute;
      width: 9px;
      height: 9px;
      border: 2px solid #050505;
      background: #f7f7f3;
      top: -5px;
    }
    .composer::before { left: -5px; }
    .composer::after { right: -5px; }
    textarea {
      min-height: 54px;
      padding: 6px 6px 0;
      color: #050505;
      font-size: 18px;
      grid-column: 1;
    }
    textarea::placeholder {
      color: #4d4d49;
      opacity: 1;
    }
    .send {
      width: 58px;
      height: 48px;
      align-self: end;
      border: 2px solid #050505;
      border-radius: 0;
      color: #ffffff;
      background: #050505;
      font-weight: 900;
      font-size: 24px;
      display: grid;
      place-items: center;
      grid-column: 2;
      grid-row: 1 / span 2;
    }
    .composer-actions {
      grid-column: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      color: #050505;
      font-size: 15px;
      text-transform: uppercase;
    }
    .fine-print {
      text-align: center;
      color: #5a5a55;
      font-size: 13px;
      margin-top: 18px;
    }
    @media (max-width: 920px) {
      .shell { grid-template-columns: 1fr; }
      aside { display: none; }
      .conversation { padding: 70px 18px 28px; }
      form { width: calc(100% - 28px); padding-bottom: 18px; }
      .composer-actions { display: none; }
      .chat-title { font-size: 18px; }
      .status { padding: 8px 10px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand-block">
        <img class="brand-logo" src="/assets/mundusx-logo.png" alt="" />
        <div>
          <div class="brand-name">MUNDUSX</div>
          <div class="brand-kicker">DECENTRALIZED AI NETWORK</div>
        </div>
      </div>
      <button class="new-chat" type="button"><span>[+] NEW CHAT</span><span>CTRL+K</span></button>
      <div class="rail-list" aria-label="Conversation history">
        <div class="history-group">
          <div class="history-label">Today</div>
          <div class="history-item active"><span>&gt;New conversation</span><span class="history-time">10:42</span></div>
          <div class="history-item"><span>Honda history draft</span><span class="history-time">09:15</span></div>
          <div class="history-item"><span>GPU node troubleshooting</span><span class="history-time">Yesterday</span></div>
          <div class="history-item"><span>MundusX architecture</span><span class="history-time">Yesterday</span></div>
        </div>
        <div class="history-group">
          <div class="history-label">Yesterday</div>
          <div class="history-item"><span>Control-plane summary</span><span class="history-time">May 27</span></div>
          <div class="history-item"><span>CUDA node jobs</span><span class="history-time">May 27</span></div>
        </div>
        <div class="history-group">
          <div class="history-label">Previous 7 days</div>
          <div class="history-item"><span>Product description draft</span><span class="history-time">May 25</span></div>
          <div class="history-item"><span>Contributor onboarding</span><span class="history-time">May 24</span></div>
          <div class="history-item"><span>Node performance analysis</span><span class="history-time">May 23</span></div>
          <div class="history-item"><span>...</span><span class="history-time"></span></div>
        </div>
      </div>
      <div class="rail-footer">
        <div class="network-line"><span><span class="network-dot"></span>MundusX Network</span><span>Online</span></div>
        <div>${escapeHtml(config.controlPlaneUrl.replace(/^https?:\/\//, ""))} <span style="float:right">[^]</span></div>
      </div>
      <div class="account-card">
        <div class="avatar-chip">DB</div>
        <div>
          <div class="account-name">Dave Batalla</div>
          <div class="account-role">Contributor</div>
        </div>
        <div>v</div>
      </div>
    </aside>
    <main>
      <header>
        <div class="chat-title">MundusX Chat <span class="model-pill">Control-plane routed</span></div>
        <div class="header-actions">
          <div class="status"><span class="dot"></span><span id="runtime-status">Ready</span></div>
          <div class="expand-control">[ &lt;=&gt; ]</div>
        </div>
      </header>
      <section class="messages" id="messages" aria-live="polite">
        <div class="conversation" id="conversation">
          <div class="welcome" id="welcome">
            <div class="welcome-inner">
              <h1>Welcome to MundusX Chat</h1>
              <div class="welcome-rule"></div>
              <p class="welcome-copy">Ask anything about MundusX - contributors, architecture, nodes, jobs, or anything else.</p>
              <div class="tip-box"><span class="tip-tag">TIP</span><span>Type your question below or use / to open commands</span></div>
              <div class="examples-heading"><span>Example Questions</span></div>
              <div class="suggestions">
                <button class="suggestion" type="button"><span>-&gt;</span><span>Give me a detailed history of Honda from its origins to today.</span></button>
                <button class="suggestion" type="button"><span>-&gt;</span><span>Explain why a CUDA node can claim a job and fail.</span></button>
                <button class="suggestion" type="button"><span>-&gt;</span><span>Draft a product description for MundusX contributors.</span></button>
                <button class="suggestion" type="button"><span>-&gt;</span><span>Summarize the current control-plane architecture.</span></button>
              </div>
            </div>
          </div>
        </div>
      </section>
      <form id="chat-form">
        <div class="composer">
          <textarea id="prompt" name="prompt" placeholder="Message MundusX..." autocomplete="off" required></textarea>
          <div class="composer-actions">
            <span>[ / ] Commands</span>
            <span>[ @ ] Web Search</span>
            <span>[ Enter to Send ]</span>
          </div>
          <button class="send" id="send" type="submit" aria-label="Send">&gt;</button>
        </div>
        <div class="fine-print">MundusX may produce inaccurate information.</div>
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
        promptEl.value = (button.querySelector("span:last-child") ?? button).textContent.trim();
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
      const pending = addMessage("Submitting to MundusX...", "assistant", "Queued");

      try {
        const created = await fetch("/api/chat/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, executionMode: "auto" }),
        });
        const submitted = await created.json();
        if (!created.ok) {
          throw new Error(submitted.error || "chat request failed");
        }

        renderPendingJob(pending, submitted);
        let payload = submitted;
        while (!["completed", "failed"].includes(payload.status)) {
          await sleep(1500);
          const polled = await fetch("/api/chat/jobs/" + encodeURIComponent(submitted.job_id));
          payload = await polled.json();
          if (!polled.ok) {
            throw new Error(payload.error || "chat poll failed");
          }
          renderPendingJob(pending, payload);
        }

        if (payload.status === "failed") {
          throw new Error(payload.error || "MundusX job failed");
        }

        const body = pending.querySelector(".message-body");
        body.textContent = payload.output || "(empty response)";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = formatJobMeta(payload);
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

    function renderPendingJob(node, payload) {
      const body = node.querySelector(".message-body");
      body.textContent = formatProgressText(payload);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatJobMeta(payload);
      body.appendChild(meta);
    }

    function formatProgressText(payload) {
      const progress = payload.progress || {};
      if (payload.status === "completed") return "Final answer ready.";
      if (progress.merging) return "Merging final synthesis...";
      if (progress.processing) return "Processing: " + progress.processing;
      if (progress.total) {
        return "Queued " + progress.completed + "/" + progress.total + " chunks complete.";
      }
      return "Queued with MundusX...";
    }

    function formatJobMeta(payload) {
      const progress = payload.progress || {};
      const chunks = progress.total ? " / " + progress.completed + "/" + progress.total + " chunks" : "";
      return "job " + payload.job_id + " / " + payload.status + " / mode " + payload.execution_mode + chunks;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
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
          model_routing: "control-plane",
          model_override: config.modelOverride || null,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonBody(request);
        const result = await submitChatTurn(body, config);
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/chat/jobs") {
        const body = await readJsonBody(request);
        const result = await submitChatJob(body, config);
        return sendJson(response, 202, result);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/chat/jobs/")) {
        const jobId = decodeURIComponent(url.pathname.slice("/api/chat/jobs/".length));
        const result = await pollChatJob(jobId, config);
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
  const submitted = await submitChatJob(body, config, fetchImpl);
  return waitForChatJob(submitted.job_id, body, config, fetchImpl);
}

export async function submitChatJob(body, config = configFromEnv(), fetchImpl = fetch) {
  const message = String(body?.message ?? "").trim();
  if (!message) {
    throw httpError(400, "message is required");
  }

  const model = String(body?.model ?? config.modelOverride ?? "").trim();
  const jobBody = {
    request_id: `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    prompt: message,
    preferred_backend: "auto",
    runtime_mode: "local",
    execution_mode: normalizeExecutionMode(body?.executionMode ?? "auto"),
    stream: false,
    system_prompt: buildChatSystemPrompt(),
    max_tokens: inferMaxTokens(message, body?.maxTokens),
    temperature: typeof body?.temperature === "number" ? body.temperature : 0.2,
    top_p: typeof body?.topP === "number" ? body.topP : 0.9,
  };
  if (model) {
    jobBody.model = model;
  }

  const jobResponse = await controlPlaneFetch(
    fetchImpl,
    config,
    "/v1/jobs",
    {
      method: "POST",
      body: JSON.stringify(jobBody),
    },
  );

  const job = jobResponse.job ?? jobResponse;
  const jobId = jobResponse.job_id ?? job.job_id;
  if (!jobId) {
    throw httpError(502, "control plane did not return a job id");
  }

  return formatChatJob(jobId, job, model || null);
}

export async function pollChatJob(jobId, config = configFromEnv(), fetchImpl = fetch) {
  if (!jobId) {
    throw httpError(400, "job id is required");
  }
  const latest = await controlPlaneFetch(fetchImpl, config, `/v1/jobs/${encodeURIComponent(jobId)}`);
  const job = latest.job ?? latest;
  return formatChatJob(jobId, job, job.model ?? config.modelOverride ?? null);
}

async function waitForChatJob(jobId, body, config, fetchImpl) {
  const timeoutSeconds = positiveInteger(body?.timeoutSeconds, config.defaultTimeoutSeconds);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await pollChatJob(jobId, config, fetchImpl);
    if (latest.status === "completed") {
      return latest;
    }
    if (latest.status === "failed") {
      throw httpError(502, latest.error || "MundusX job failed");
    }
    await delay(POLL_INTERVAL_MS);
  }

  const status = latest?.status ?? "unknown";
  throw httpError(504, `timed out waiting for job ${jobId} while status was ${status}`);
}

function formatChatJob(jobId, job, fallbackModel) {
  const output = job.status === "completed" ? cleanChatOutput(job.output ?? "") : "";
  return {
    job_id: jobId,
    status: job.status,
    output,
    output_cleaned: job.status === "completed" && output !== String(job.output ?? ""),
    error: job.error ?? null,
    model: job.model ?? fallbackModel,
    assigned_node_id: job.assigned_node_id ?? null,
    execution_mode: job.execution_mode ?? "single",
    graph_execution_enabled: Boolean(job.graph_execution_enabled),
    progress: summarizeChatProgress(job),
  };
}

function summarizeChatProgress(job) {
  const graph = job.graph ?? {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!nodes.length) {
    return {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: job.plan?.strategy ?? "single_job",
    };
  }

  const completed = nodes.filter((node) => node.status === "completed").length;
  const runningNodes = nodes.filter((node) => node.status === "running" || node.status === "assigned");
  const failed = nodes.filter((node) => node.status === "failed").length;
  const waiting = nodes.filter((node) => node.status === "waiting" || node.status === "ready").length;
  const activeNode =
    nodes.find((node) => node.id === job.active_graph_node_id) ?? runningNodes[0] ?? null;
  const finalNodeId = graph.final_node_id ?? null;
  const merging =
    Boolean(activeNode) &&
    (activeNode.id === finalNodeId || String(activeNode.responsibility ?? "") === "merge");

  return {
    total: nodes.length,
    completed,
    running: runningNodes.length,
    failed,
    waiting,
    processing: activeNode?.name ?? null,
    merging,
    strategy: job.plan?.strategy ?? graph.strategy ?? "graph",
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      status: node.status,
      assigned_node_id: node.assigned_node_id ?? null,
    })),
  };
}

function normalizeExecutionMode(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (["single", "auto", "decompose"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function inferMaxTokens(message, explicitValue) {
  const explicit = positiveInteger(explicitValue, 0);
  if (explicit > 0) {
    return explicit;
  }

  const lower = message.toLowerCase();
  if (containsAny(lower, ["detailed", "complete", "full", "comprehensive", "history of", "report"])) {
    return 1024;
  }
  if (message.length > 600) {
    return 768;
  }
  return 384;
}

function buildChatSystemPrompt() {
  return [
    "You are MundusX Chat.",
    "Answer the user's request directly.",
    "Do not echo system, assistant, or user role labels.",
    "Do not repeat the same sentence.",
    "If the request asks for a full program or long explanation, provide the complete useful answer.",
  ].join(" ");
}

function containsAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
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

export function cleanChatOutput(value) {
  let output = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

  output = stripWorkerTrace(output);
  output = stripRolePrefixes(output);
  output = stripEmbeddedRoleLeak(output);
  output = collapseRepeatedSentences(output);
  output = collapseRepeatedLines(output);
  output = output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!output) {
    return "MundusX returned an empty response. Please try again.";
  }
  return output;
}

function stripWorkerTrace(value) {
  const responseIndex = value.search(/(?:^|;\s*)response=/i);
  if (responseIndex === -1) {
    return value;
  }

  const responsePrefix = value.slice(responseIndex).match(/^(?:;\s*)?response=/i)?.[0] ?? "";
  return value.slice(responseIndex + responsePrefix.length).trim();
}

function stripRolePrefixes(value) {
  let output = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = output.replace(/^(?:system|assistant|user)\s*:\s*/i, "").trim();
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripEmbeddedRoleLeak(value) {
  const roleMatch = value.match(/\s(?:system|assistant|user)\s*:\s*/i);
  if (!roleMatch || roleMatch.index === undefined) {
    return value;
  }

  const before = value.slice(0, roleMatch.index).trim();
  const after = value.slice(roleMatch.index + roleMatch[0].length).trim();
  if (!after) {
    return before;
  }

  if (!before || before.endsWith("?") || before.length < 24) {
    return after;
  }

  return before;
}

function collapseRepeatedSentences(value) {
  const sentences = value.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+(?:\n|$)/g);
  if (!sentences || sentences.length < 2) {
    return value;
  }

  const collapsed = [];
  const seen = new Set();

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeRepeatKey(trimmed);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    collapsed.push(trimmed);
  }

  return collapsed.join(" ");
}

function collapseRepeatedLines(value) {
  const lines = value.split("\n");
  const collapsed = [];
  let previousKey = "";

  for (const line of lines) {
    const key = normalizeRepeatKey(line);
    if (key && key === previousKey) {
      continue;
    }
    collapsed.push(line);
    previousKey = key;
  }

  return collapsed.join("\n");
}

function normalizeRepeatKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[`*_()[\]{}\\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
