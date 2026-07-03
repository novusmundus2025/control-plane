import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { connect as createTlsConnection } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_CONTROL_PLANE_URL = "https://uat.mundusx.ai";
const DEFAULT_TIMEOUT_SECONDS = 90;
const DEFAULT_WEATHER_TTL_SECONDS = 7200;
const DEFAULT_WEATHER_URL = "https://wttr.in";
const DEFAULT_FACTUAL_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary";
const DEFAULT_WIKIDATA_ENTITY_URL = "https://www.wikidata.org/wiki/Special:EntityData";
const POLL_INTERVAL_MS = 1500;
const MAX_BODY_BYTES = 64 * 1024;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = resolve(MODULE_DIR, "../public/mundusx-logo.png");

const ICON_SPARKLE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20"/></svg>';
const ICON_HELP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a2.9 2.9 0 1 1 3.8 2.76c-.74.29-1.4.9-1.4 1.74v.5"/><path d="M12 17h.01"/></svg>';
const ICON_ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const ICON_ARROW_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_CPU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 7V4M15 7V4M9 20v-3M15 20v-3M7 9H4M7 15H4M20 9h-3M20 15h-3"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M17.5 3.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 8.5-8.5Z"/></svg>';
const ICON_LAYERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/></svg>';
const ICON_CHAT_BUBBLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

const WELCOME_INNER_HTML = `<div class="welcome-inner">
              <h1>Welcome to <span class="grad-text">MundusX</span> Chat</h1>
              <div class="welcome-rule"></div>
              <p class="welcome-copy">Ask anything about MundusX - contributors, architecture, nodes, jobs, or anything else.</p>
              <div class="examples-heading"><span>Example Questions</span></div>
              <div class="suggestions">
                <button class="suggestion" type="button"><span class="suggestion-icon icon-purple">${ICON_CLOCK}</span><span class="suggestion-text">Give me a detailed history of Honda from its origins to today.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
                <button class="suggestion" type="button"><span class="suggestion-icon icon-blue">${ICON_CPU}</span><span class="suggestion-text">Explain why a CUDA node can claim a job and fail.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
                <button class="suggestion" type="button"><span class="suggestion-icon icon-green">${ICON_EDIT}</span><span class="suggestion-text">Draft a product description for MundusX contributors.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
                <button class="suggestion" type="button"><span class="suggestion-icon icon-orange">${ICON_LAYERS}</span><span class="suggestion-text">Summarize the current control-plane architecture.</span><span class="suggestion-arrow">${ICON_ARROW_RIGHT}</span></button>
              </div>
            </div>`;

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? "3002"),
    controlPlaneUrl: normalizeOrigin(env.MUNDUSX_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL),
    operatorToken: (env.MUNDUSX_OPERATOR_TOKEN ?? env.OPENGPU_OPERATOR_TOKEN ?? "").trim(),
    modelOverride: (env.MUNDUSX_CHAT_MODEL ?? env.MUNDUSX_CHAT_DEFAULT_MODEL ?? "").trim(),
    weatherCacheUrl: (
      env.MUNDUSX_WEATHER_CACHE_URL ??
      env.VALKEY_URL ??
      env.REDIS_URL ??
      ""
    ).trim(),
    weatherBaseUrl: normalizeOrigin(env.MUNDUSX_WEATHER_URL ?? DEFAULT_WEATHER_URL),
    factualSummaryBaseUrl: normalizeOrigin(
      env.MUNDUSX_FACTUAL_SUMMARY_URL ?? DEFAULT_FACTUAL_SUMMARY_URL,
    ),
    wikidataEntityBaseUrl: normalizeOrigin(
      env.MUNDUSX_WIKIDATA_ENTITY_URL ?? DEFAULT_WIKIDATA_ENTITY_URL,
    ),
    weatherTtlSeconds: positiveInteger(
      env.MUNDUSX_WEATHER_TTL_SECONDS,
      DEFAULT_WEATHER_TTL_SECONDS,
    ),
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
      color-scheme: light;
      --bg: #f6f7fb;
      --rail: #ffffff;
      --panel: #ffffff;
      --panel-2: #ffffff;
      --line: #e7e9f2;
      --line-strong: #d7dbec;
      --text: #12131c;
      --muted: #6b7280;
      --muted-2: #94a3b8;
      --purple: #7c6cf6;
      --blue: #3b82f6;
      --cyan: #2f6fed;
      --green: #17a668;
      --red: #e5484d;
      --amber: #b45309;
      --gradient: linear-gradient(135deg, #3b8bff 0%, #7c5cf0 100%);
      --motion-fast: 140ms ease;
      --motion-medium: 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
      --focus-ring: 0 0 0 3px rgba(124, 108, 246, 0.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
    }
    a { color: inherit; text-decoration: none; }
    button { font: inherit; cursor: pointer; }
    button:focus-visible,
    a:focus-visible {
      outline: 0;
      box-shadow: var(--focus-ring);
    }
    code {
      background: rgba(124, 108, 246, 0.1);
      border: 1px solid rgba(124, 108, 246, 0.18);
      border-radius: 8px;
      color: #4338ca;
      padding: 2px 6px;
    }

    .shell {
      height: 100vh;
      min-height: 0;
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr);
    }

    /* ---- Sidebar / menu column ---- */
    aside {
      height: 100vh;
      min-height: 0;
      border-right: 1px solid var(--line);
      background: var(--rail);
      padding: 22px 16px 18px;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto auto;
      gap: 16px;
    }
    .brand-block {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 2px 4px;
    }
    .brand-logo {
      width: 40px;
      height: 40px;
      object-fit: contain;
      flex: 0 0 auto;
      transition: transform var(--motion-medium);
    }
    .brand-block:hover .brand-logo {
      transform: scale(1.04);
    }
    .brand-name {
      font-family: Inter, "Segoe UI", sans-serif;
      font-weight: 800;
      font-size: 19px;
      line-height: 1.15;
      color: var(--text);
    }
    .brand-kicker {
      margin-top: 3px;
      color: var(--muted-2);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .network-summary {
      display: flex;
      align-items: center;
      min-height: 48px;
      padding: 0 16px;
      border-radius: 10px;
      border: 1px solid rgba(107, 114, 128, 0.18);
      background: rgba(107, 114, 128, 0.06);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      width: 100%;
    }
    .network-summary.is-online {
      border-color: rgba(23, 166, 104, 0.28);
      background: #eafbf2;
      color: var(--green);
    }
    .network-summary.is-waiting {
      border-color: #f7dfae;
      background: #fff6e8;
      color: var(--amber);
    }
    .network-summary.is-offline {
      border-color: rgba(229, 72, 77, 0.28);
      background: #fdedee;
      color: var(--red);
    }
    .network-signal {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .online-dot,
    .network-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }

    .new-chat {
      width: 100%;
      min-height: 48px;
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      color: var(--text);
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 0 16px;
      font-weight: 650;
      font-size: 14px;
      transition: background var(--motion-fast);
    }
    .new-chat:hover,
    .new-chat:focus-visible {
      background: #f1f2f9;
    }
    .new-chat .kbd-hint {
      background: #f4f5f9;
      border: 1px solid var(--line-strong);
      color: var(--muted);
      border-radius: 6px;
      padding: 3px 7px;
      font-size: 12px;
      font-weight: 600;
    }

    .rail-list {
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      display: grid;
      align-content: start;
      gap: 14px;
      padding-right: 2px;
    }
    .history-group {
      display: grid;
      gap: 6px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .history-group:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .history-label {
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .history-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      overflow: hidden;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 9px 10px;
      color: #414a5a;
      font-size: 13px;
      background: transparent;
      transition: color var(--motion-fast), background var(--motion-fast);
    }
    .history-item:hover,
    .history-item:focus-visible {
      color: var(--text);
      background: #f1f2f9;
      outline: 0;
    }
    .history-item.active {
      color: var(--purple);
      border-color: rgba(124, 108, 246, 0.4);
      background: linear-gradient(90deg, rgba(124, 108, 246, 0.14), rgba(59, 130, 246, 0.06));
    }
    .history-title {
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-time {
      flex: 0 0 auto;
      color: var(--muted-2);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-empty {
      min-height: 100%;
      display: grid;
      align-content: center;
      justify-items: center;
      gap: 6px;
      text-align: center;
      padding: 12px 8px;
    }
    .history-empty-icon {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: #f1ecfe;
      color: var(--purple);
      margin-bottom: 6px;
    }
    .history-empty-icon svg { width: 22px; height: 22px; }
    .history-empty-title {
      color: var(--text);
      font-weight: 700;
      font-size: 14px;
    }
    .history-empty-copy {
      color: var(--muted-2);
      font-size: 12px;
    }

    .rail-footer {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      padding: 14px;
      color: var(--muted-2);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .network-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: var(--text);
      font-weight: 650;
      font-size: 13px;
    }
    .network-line span:first-child { display: inline-flex; align-items: center; gap: 8px; }
    .network-line .network-dot { color: var(--green); }
    .network-line span:last-child { color: var(--cyan); font-size: 12px; font-weight: 700; letter-spacing: 0.03em; }
    #network-latency { color: var(--green); font-weight: 700; }

    .icon-row {
      display: flex;
      align-items: center;
      gap: 10px;
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .icon-btn {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border: 1px solid transparent;
      border-radius: 8px;
      color: var(--muted-2);
      background: transparent;
      transition: color var(--motion-fast), background var(--motion-fast);
    }
    .icon-btn:hover,
    .icon-btn:focus-visible {
      color: var(--text);
      background: #f1f2f9;
      outline: 0;
    }
    .icon-btn svg { width: 18px; height: 18px; }

    /* ---- Main column ---- */
    main {
      min-width: 0;
      height: 100vh;
      min-height: 0;
      display: grid;
      grid-template-rows: 58px minmax(0, 1fr) auto;
      background: transparent;
    }
    header {
      padding: 0 24px;
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
      color: var(--text);
      font-weight: 700;
      font-size: 15px;
    }
    .chat-title-icon {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: var(--gradient);
      color: #fff;
      flex: 0 0 auto;
    }
    .chat-title-icon svg { width: 15px; height: 15px; }
    .runtime-status-sentinel {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 14px;
      color: var(--green);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      background: #fff;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }
    .runtime-status-sentinel[data-state="working"] { color: var(--amber); }
    .runtime-status-sentinel[data-state="error"] { color: var(--red); }
    .header-actions {
      display: none;
    }

    .messages {
      min-height: 0;
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
      min-height: 40vh;
      display: grid;
      place-items: center;
      text-align: center;
    }
    .welcome-inner {
      width: min(680px, 100%);
      display: grid;
      gap: 16px;
      justify-items: center;
    }
    h1 {
      margin: 0;
      color: var(--text);
      font-size: clamp(28px, 4.4vw, 40px);
      line-height: 1.1;
      font-weight: 800;
    }
    h1 .grad-text {
      background: var(--gradient);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .welcome-rule {
      width: 46px;
      height: 3px;
      border-radius: 2px;
      background: var(--gradient);
    }
    .welcome-copy {
      max-width: 40rem;
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
    }
    .examples-heading {
      width: min(560px, 100%);
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 16px;
      margin-top: 4px;
      color: var(--muted-2);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .examples-heading::before,
    .examples-heading::after {
      content: "";
      border-top: 1px solid var(--line);
    }
    .suggestions {
      width: min(700px, 100%);
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .suggestion {
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr) 16px;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel-2);
      color: var(--text);
      text-align: left;
      font-size: 13px;
      line-height: 1.4;
      padding: 12px 14px;
      transition: transform var(--motion-medium), border-color var(--motion-fast), box-shadow var(--motion-medium);
    }
    .suggestion:hover,
    .suggestion:focus-visible {
      transform: translateY(-2px);
      border-color: var(--line-strong);
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.1);
    }
    .suggestion-icon {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      flex: 0 0 auto;
    }
    .suggestion-icon svg { width: 18px; height: 18px; }
    .suggestion-icon.icon-purple { background: #f1ecfe; color: var(--purple); }
    .suggestion-icon.icon-blue { background: #e8f2ff; color: var(--blue); }
    .suggestion-icon.icon-green { background: #e7f9ee; color: var(--green); }
    .suggestion-icon.icon-orange { background: #fff1e0; color: #ea8a2b; }
    .suggestion-arrow {
      color: var(--muted-2);
      flex: 0 0 auto;
    }
    .suggestion-arrow svg { width: 16px; height: 16px; }

    .message {
      width: 100%;
      display: flex;
      padding: 10px 0;
    }
    .message.user {
      justify-content: flex-end;
    }
    .message-body {
      min-width: 0;
      max-width: min(760px, 82%);
      color: var(--text);
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .message.user .message-body {
      max-width: min(660px, 74%);
      background: linear-gradient(90deg, rgba(124, 108, 246, 0.12), rgba(59, 130, 246, 0.08));
      border: 1px solid rgba(124, 108, 246, 0.25);
      border-radius: 16px 16px 4px 16px;
      padding: 12px 16px;
    }
    .message.assistant .message-body {
      width: 100%;
      max-width: 100%;
    }
    .message.error .message-body {
      color: #b3231f;
    }
    .meta {
      color: var(--muted-2);
      font-size: 12px;
      margin-top: 8px;
    }
    .message-body p { margin: 0 0 12px; }
    .message-body p:last-child { margin-bottom: 0; }
    .message-body ol,
    .message-body ul {
      margin: 10px 0 12px;
      padding-left: 24px;
    }
    .message-body li {
      margin: 8px 0;
      padding-left: 4px;
    }
    .message-body strong {
      font-weight: 800;
    }
    .message-body code:not(.code-block code) {
      background: rgba(0,0,0,0.06);
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 5px;
      padding: 1px 5px;
      font-size: 0.94em;
    }
    .code-block {
      margin: 12px 0;
      border: 1px solid #1f2430;
      background: #12141c;
      border-radius: 10px;
      overflow: hidden;
    }
    .code-label {
      border-bottom: 1px solid #1f2430;
      padding: 7px 12px;
      color: #8a93a6;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .code-block pre {
      margin: 0;
      padding: 14px;
      overflow: auto;
      white-space: pre;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    .code-block code {
      color: #d9edff;
      background: transparent;
      border: 0;
      border-radius: 0;
      padding: 0;
    }

    .work-trace { display: grid; gap: 12px; }
    .work-title {
      display: flex;
      align-items: center;
      color: var(--text);
      font-weight: 650;
      font-size: 13px;
    }
    .chunk-list { display: grid; gap: 8px; }
    .chunk-row {
      border: 1px solid var(--line);
      background: var(--panel-2);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .chunk-row.is-active {
      border-color: rgba(124, 108, 246, 0.4);
      box-shadow: 0 0 0 3px rgba(124, 108, 246, 0.08);
    }
    .chunk-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      color: var(--text);
      font-size: 13px;
    }
    .chunk-status {
      color: var(--muted-2);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .chunk-status.is-active {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--cyan);
    }
    .chunk-meta {
      margin-top: 6px;
      color: var(--muted-2);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .chunk-output {
      margin-top: 9px;
      color: #414a5a;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 160px;
      overflow: auto;
      border-top: 1px solid var(--line);
      padding-top: 9px;
      font-size: 13px;
    }
    .mx-spinner {
      width: 12px;
      height: 12px;
      border: 1.5px solid rgba(124, 108, 246, 0.24);
      border-top-color: var(--cyan);
      border-radius: 999px;
      animation: mx-spin 0.72s linear infinite;
      flex: 0 0 auto;
    }
    .thinking-dots {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      margin-left: 8px;
    }
    .thinking-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.25;
      animation: mx-dot 1s ease-in-out infinite;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.14s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.28s; }
    @keyframes mx-spin { to { transform: rotate(360deg); } }
    @keyframes mx-dot {
      0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
      40% { opacity: 1; transform: translateY(-2px); }
    }

    .source-chunks {
      margin-top: 16px;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    .source-chunks summary {
      cursor: pointer;
      color: var(--muted-2);
      font-size: 12px;
    }

    form {
      width: min(880px, 100%);
      margin: 0 auto;
      padding: 14px 18px 22px;
    }
    .composer {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #fff;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto auto;
      gap: 8px 10px;
      padding: 14px 16px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
    }
    textarea {
      grid-column: 1;
      min-height: 52px;
      max-height: 180px;
      resize: none;
      border: 0;
      padding: 6px 4px;
      color: var(--text);
      background: transparent;
      font: inherit;
      font-size: 14px;
      outline: none;
    }
    textarea::placeholder { color: var(--muted-2); }
    .composer-actions {
      grid-column: 1;
      display: flex;
      align-items: center;
      gap: 16px;
      color: var(--muted-2);
      font-size: 12px;
    }
    .kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      margin-right: 6px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #f4f5f9;
      color: var(--muted);
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: 11px;
    }
    .send {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: end;
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 50%;
      color: #fff;
      background: var(--gradient);
      font-weight: 700;
      display: grid;
      place-items: center;
      box-shadow: 0 10px 22px rgba(90, 90, 240, 0.3);
      transition: transform var(--motion-medium), box-shadow var(--motion-medium);
    }
    .send svg { width: 18px; height: 18px; }
    .send:hover:not(:disabled),
    .send:focus-visible {
      transform: translateY(-1px);
      box-shadow: 0 14px 28px rgba(90, 90, 240, 0.4);
    }
    .send:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .fine-print {
      text-align: center;
      color: var(--muted-2);
      font-size: 12px;
      margin-top: 12px;
    }

    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside { display: none; }
      .conversation { padding: 24px 14px 20px; }
      .suggestions { grid-template-columns: 1fr; }
      form { padding: 12px 14px 18px; }
    }
  </style>
</head>
<body>
  <div class="shell" data-control-plane="${escapeHtml(config.controlPlaneUrl)}">
    <aside>
      <div class="brand-block">
        <img class="brand-logo" src="/assets/mundusx-logo.png" alt="" />
        <div>
          <div class="brand-name">MundusX</div>
          <div class="brand-kicker">Decentralized AI Network</div>
        </div>
      </div>
      <div class="network-summary">
        <span class="network-signal"><i class="online-dot"></i><span id="network-state">Checking network</span></span>
      </div>
      <button class="new-chat" id="new-chat" type="button"><span>+ New Chat</span><span class="kbd-hint">&#8984; K</span></button>
      <div class="rail-list" id="history-list" aria-label="Conversation history"></div>
      <div class="rail-footer">
        <div class="network-line"><span><span class="network-dot"></span>MundusX Network</span><span id="network-card-state">Syncing</span></div>
        <div id="network-card-metrics">-- nodes - -- queued - routed</div>
        <div>Latency <span id="network-latency">-- ms</span> - Jobs <span id="network-jobs">--</span></div>
      </div>
      <div class="icon-row">
        <button class="icon-btn" id="theme-toggle" type="button" title="Toggle theme" aria-label="Toggle theme">${ICON_SUN}</button>
        <button class="icon-btn" type="button" title="Documentation" aria-label="Documentation">${ICON_BOOK}</button>
        <button class="icon-btn" type="button" title="Help" aria-label="Help">${ICON_HELP}</button>
      </div>
    </aside>
    <main>
      <header>
        <div class="chat-title"><span class="chat-title-icon">${ICON_SPARKLE}</span>MundusX Chat</div>
        <span class="runtime-status-sentinel" id="runtime-status" data-state="ready"><span class="status-dot"></span><span id="runtime-status-text">Ready</span></span>
      </header>
      <section class="messages" id="messages" aria-live="polite">
        <div class="conversation" id="conversation">
          <div class="welcome" id="welcome">
            ${WELCOME_INNER_HTML}
          </div>
        </div>
      </section>
      <form id="chat-form">
        <div class="composer">
          <textarea id="prompt" name="prompt" placeholder="Message MundusX..." autocomplete="off" required></textarea>
          <div class="composer-actions">
            <span><span class="kbd">/</span>Commands</span>
            <span><span class="kbd">@</span>Web Search</span>
            <span><span class="kbd">&#8629;</span>Enter to Send</span>
          </div>
          <button class="send" id="send" type="submit" aria-label="Send">${ICON_ARROW_UP}</button>
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
    const statusTextEl = document.getElementById("runtime-status-text");
    const historyListEl = document.getElementById("history-list");
    const newChatEl = document.getElementById("new-chat");
    const historyKey = "mundusx.chat.history.v1";

    renderHistory();
    hydrateNetwork();
    setInterval(hydrateNetwork, 15000);

    function addMessage(text, role, meta) {
      document.getElementById("welcome")?.remove();
      const node = document.createElement("div");
      node.className = "message" + (role ? " " + role : "");
      node.setAttribute("aria-label", role === "user" ? "Your message" : "MundusX response");
      const body = document.createElement("div");
      body.className = "message-body";
      body.textContent = text;
      if (meta) {
        const metaNode = document.createElement("div");
        metaNode.className = "meta";
        metaNode.textContent = meta;
        body.appendChild(metaNode);
      }
      node.appendChild(body);
      messagesEl.appendChild(node);
      document.getElementById("messages").scrollTop = document.getElementById("messages").scrollHeight;
      return node;
    }

    document.querySelectorAll(".suggestion").forEach((button) => {
      button.addEventListener("click", () => {
        promptEl.value = (button.querySelector(".suggestion-text") ?? button).textContent.trim();
        promptEl.focus();
      });
    });

    function setStatus(state, label) {
      statusEl.dataset.state = state;
      statusTextEl.textContent = label;
    }

    newChatEl?.addEventListener("click", () => {
      messagesEl.querySelectorAll(".message").forEach((node) => node.remove());
      if (!document.getElementById("welcome")) {
        messagesEl.prepend(createWelcome());
      }
      promptEl.value = "";
      promptEl.focus();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = promptEl.value.trim();
      if (!message) return;

      saveHistory(message);
      addMessage(message, "user");
      promptEl.value = "";
      sendEl.disabled = true;
      setStatus("working", "Working");
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

        renderCompletedJob(pending, payload);
        setStatus("ready", "Ready");
      } catch (error) {
        pending.className = "message error";
        const body = pending.querySelector(".message-body");
        body.textContent = error.message;
        setStatus("error", "Error");
      } finally {
        sendEl.disabled = false;
        promptEl.focus();
      }
    });

    function renderPendingJob(node, payload) {
      const body = node.querySelector(".message-body");
      body.textContent = "";
      body.appendChild(createWorkTrace(payload));
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatJobMeta(payload);
      body.appendChild(meta);
    }

    function renderCompletedJob(node, payload) {
      const body = node.querySelector(".message-body");
      const userPrompt = findPreviousUserMessage(node);
      const output = stripEchoedPrompt(payload.output || "(empty response)", userPrompt);
      body.textContent = "";
      appendRichMessage(body, output);
      if (payload.progress?.nodes?.some((chunk) => chunk.output)) {
        body.appendChild(createSourceChunks(payload));
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatJobMeta(payload);
      body.appendChild(meta);
    }

    function findPreviousUserMessage(node) {
      let cursor = node.previousElementSibling;
      while (cursor) {
        if (cursor.classList.contains("user")) {
          return cursor.querySelector(".message-body")?.textContent?.trim() || "";
        }
        cursor = cursor.previousElementSibling;
      }
      return "";
    }

    function stripEchoedPrompt(output, prompt) {
      let text = String(output || "").trim();
      const originalPrompt = String(prompt || "").trim();
      if (!text || !originalPrompt) return text;
      if (text.toLowerCase().startsWith(originalPrompt.toLowerCase())) {
        text = text.slice(originalPrompt.length).trim();
      }
      text = text
        .replace(/^please provide the complete code for this program\\.?\\s*/i, "")
        .replace(/^here(?:'s| is)\\s+(?:the\\s+)?(?:complete\\s+)?(?:code|program)[:.\\s-]*/i, "")
        .trim();
      return text || output;
    }

    function appendRichMessage(container, text) {
      const parts = splitMarkdownCode(String(text || ""));
      if (!parts.some((part) => part.type === "code") && looksLikeCode(text)) {
        container.appendChild(createCodeBlock("code", formatCodeForDisplay(text)));
        return;
      }
      for (const part of parts) {
        if (part.type === "code") {
          container.appendChild(createCodeBlock(part.language, formatCodeForDisplay(part.value)));
        } else {
          appendTextParagraphs(container, part.value);
        }
      }
    }

    function splitMarkdownCode(text) {
      const parts = [];
      const fence = String.fromCharCode(96).repeat(3);
      let index = 0;
      while (index < text.length) {
        const start = text.indexOf(fence, index);
        if (start === -1) break;
        if (start > index) {
          parts.push({ type: "text", value: text.slice(index, start) });
        }
        const contentStart = start + fence.length;
        const end = text.indexOf(fence, contentStart);
        if (end === -1) break;
        const raw = text.slice(contentStart, end).replace(/^\\n/, "");
        const firstBreak = raw.indexOf("\\n");
        const firstLine = firstBreak === -1 ? "" : raw.slice(0, firstBreak).trim();
        const hasLanguage = /^[a-zA-Z0-9_+#.-]{1,24}$/.test(firstLine);
        parts.push({
          type: "code",
          language: hasLanguage ? firstLine : "code",
          value: hasLanguage ? raw.slice(firstBreak + 1) : raw,
        });
        index = end + fence.length;
      }
      if (index < text.length) {
        parts.push({ type: "text", value: text.slice(index) });
      }
      return parts.length ? parts : [{ type: "text", value: text }];
    }

    function appendTextParagraphs(container, text) {
      const blocks = normalizeAssistantDisplayText(text).split(/\\n{2,}/).filter(Boolean);
      for (const block of blocks) {
        const list = createListBlock(block);
        if (list) {
          container.appendChild(list);
          continue;
        }
        const node = document.createElement("p");
        appendInlineMarkdown(node, block.trim());
        container.appendChild(node);
      }
    }

    function normalizeAssistantDisplayText(text) {
      return String(text || "")
        .replace(/\\r\\n/g, "\\n")
        .replace(/\\s+(\\d+)\\.\\s+(?=\\*\\*|[A-Z0-9])/g, "\\n$1. ")
        .replace(/\\s+[-*]\\s+(?=\\*\\*|[A-Z0-9])/g, "\\n- ")
        .replace(/\\n{3,}/g, "\\n\\n")
        .trim();
    }

    function createListBlock(block) {
      const lines = String(block || "").split("\\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length < 2) return null;
      const ordered = lines.every((line) => /^\\d+\\.\\s+/.test(line));
      const unordered = lines.every((line) => /^[-*]\\s+/.test(line));
      if (!ordered && !unordered) return null;
      const list = document.createElement(ordered ? "ol" : "ul");
      for (const line of lines) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, line.replace(ordered ? /^\\d+\\.\\s+/ : /^[-*]\\s+/, ""));
        list.appendChild(item);
      }
      return list;
    }

    function appendInlineMarkdown(parent, text) {
      const value = String(text || "");
      const tick = String.fromCharCode(96);
      const pattern = new RegExp("(\\\\*\\\\*[^*]+\\\\*\\\\*|" + tick + "[^" + tick + "]+" + tick + ")", "g");
      let index = 0;
      for (const match of value.matchAll(pattern)) {
        if (match.index > index) {
          parent.appendChild(document.createTextNode(value.slice(index, match.index)));
        }
        const token = match[0];
        const node = document.createElement(token.startsWith("**") ? "strong" : "code");
        node.textContent = token.startsWith("**") ? token.slice(2, -2) : token.slice(1, -1);
        parent.appendChild(node);
        index = match.index + token.length;
      }
      if (index < value.length) {
        parent.appendChild(document.createTextNode(value.slice(index)));
      }
    }

    function createCodeBlock(language, code) {
      const wrapper = document.createElement("div");
      wrapper.className = "code-block";
      const label = document.createElement("div");
      label.className = "code-label";
      label.textContent = language || "code";
      const pre = document.createElement("pre");
      const codeNode = document.createElement("code");
      codeNode.textContent = code;
      pre.appendChild(codeNode);
      wrapper.appendChild(label);
      wrapper.appendChild(pre);
      return wrapper;
    }

    function looksLikeCode(text) {
      const value = String(text || "");
      return /\\b(public\\s+class|class\\s+\\w+|import\\s+java\\.|#include\\s*<|function\\s+\\w+\\s*\\(|const\\s+\\w+\\s*=|def\\s+\\w+\\s*\\()/m.test(value) &&
        (value.match(/[;{}]/g) || []).length >= 4;
    }

    function formatCodeForDisplay(code) {
      const raw = String(code || "").trim();
      if (raw.includes("\\n")) return raw;
      let formatted = raw
        .replace(/\\s*;\\s*/g, ";\\n")
        .replace(/\\s*\\{\\s*/g, " {\\n")
        .replace(/\\s*\\}\\s*/g, "\\n}\\n")
        .replace(/\\n{2,}/g, "\\n")
        .trim();
      const lines = formatted.split("\\n");
      let depth = 0;
      return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return "";
        if (trimmed.startsWith("}")) depth = Math.max(0, depth - 1);
        const out = "  ".repeat(depth) + trimmed;
        if (trimmed.endsWith("{")) depth += 1;
        return out;
      }).join("\\n");
    }

    function createWorkTrace(payload) {
      const progress = payload.progress || {};
      const wrapper = document.createElement("div");
      wrapper.className = "work-trace";
      const title = document.createElement("div");
      title.className = "work-title";
      title.textContent = formatProgressText(payload);
      if (!["completed", "failed"].includes(payload.status)) {
        title.appendChild(createThinkingDots());
      }
      wrapper.appendChild(title);

      if (progress.nodes?.length) {
        const list = document.createElement("div");
        list.className = "chunk-list";
        for (const chunk of progress.nodes) {
          list.appendChild(createChunkRow(chunk));
        }
        wrapper.appendChild(list);
      }

      return wrapper;
    }

    function createSourceChunks(payload) {
      const details = document.createElement("details");
      details.className = "source-chunks";
      const summary = document.createElement("summary");
      summary.textContent = "Source chunks";
      details.appendChild(summary);
      const list = document.createElement("div");
      list.className = "chunk-list";
      for (const chunk of payload.progress.nodes.filter((node) => node.output)) {
        list.appendChild(createChunkRow(chunk));
      }
      details.appendChild(list);
      return details;
    }

    function createChunkRow(chunk) {
      const row = document.createElement("div");
      const active = isActiveChunkStatus(chunk.status);
      row.className = "chunk-row" + (active ? " is-active" : "");
      const head = document.createElement("div");
      head.className = "chunk-head";
      const name = document.createElement("span");
      name.textContent = chunk.name || chunk.id || "Chunk";
      const status = document.createElement("span");
      status.className = "chunk-status" + (active ? " is-active" : "");
      if (active) {
        const spinner = document.createElement("span");
        spinner.className = "mx-spinner";
        spinner.setAttribute("aria-hidden", "true");
        status.appendChild(spinner);
      }
      status.appendChild(document.createTextNode(chunk.status || "waiting"));
      head.appendChild(name);
      head.appendChild(status);
      row.appendChild(head);
      const telemetry = formatChunkTelemetry(chunk);
      if (telemetry) {
        const meta = document.createElement("div");
        meta.className = "chunk-meta";
        meta.textContent = telemetry;
        row.appendChild(meta);
      }
      if (chunk.output) {
        const output = document.createElement("div");
        output.className = "chunk-output";
        output.textContent = chunk.output;
        row.appendChild(output);
      }
      return row;
    }

    function formatChunkTelemetry(chunk) {
      const parts = [];
      if (chunk.assigned_node_id) parts.push("node " + chunk.assigned_node_id);
      if (Number.isFinite(chunk.latency_ms)) parts.push("latency " + chunk.latency_ms + " ms");
      if (Number.isFinite(chunk.queue_wait_ms)) parts.push("queue " + chunk.queue_wait_ms + " ms");
      if (Number.isFinite(chunk.output_chars)) parts.push(chunk.output_chars + " chars");
      if (Number.isFinite(chunk.effective_max_tokens)) parts.push("max " + chunk.effective_max_tokens + " tokens");
      return parts.join(" - ");
    }

    function isActiveChunkStatus(status) {
      return ["ready", "queued", "assigned", "running", "waiting", "processing", "merging"]
        .includes(String(status || "").toLowerCase());
    }

    function createThinkingDots() {
      const dots = document.createElement("span");
      dots.className = "thinking-dots";
      dots.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 3; index += 1) {
        dots.appendChild(document.createElement("span"));
      }
      return dots;
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

    async function hydrateNetwork() {
      const started = performance.now();
      try {
        const response = await fetch("/api/network");
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "network unavailable");
        const latency = Math.max(1, Math.round(performance.now() - started));
        const summary = document.querySelector(".network-summary");
        summary?.classList.toggle("is-online", payload.online_count > 0);
        summary?.classList.toggle("is-waiting", payload.online_count === 0);
        summary?.classList.remove("is-offline");
        setText("network-state", payload.online_count > 0 ? "Online - nodes ready" : "Standby - no ready nodes");
        setText("network-card-state", payload.online_count > 0 ? "ONLINE" : "WAITING");
        setText("network-card-metrics", payload.online_count + " nodes - " + payload.queued_job_count + " queued - " + payload.model_routing);
        setText("network-latency", latency + " ms");
        setText("network-jobs", payload.completed_job_count + " completed");
      } catch {
        const summary = document.querySelector(".network-summary");
        summary?.classList.remove("is-online", "is-waiting");
        summary?.classList.add("is-offline");
        setText("network-state", "Control plane offline");
        setText("network-card-state", "OFFLINE");
        setText("network-card-metrics", "control plane unavailable");
        setText("network-latency", "-- ms");
        setText("network-jobs", "--");
      }
    }

    function saveHistory(message) {
      const items = readHistory();
      const now = Date.now();
      const next = [
        { id: String(now), title: message.slice(0, 72), createdAt: now },
        ...items.filter((item) => item.title !== message).slice(0, 29),
      ];
      localStorage.setItem(historyKey, JSON.stringify(next));
      renderHistory();
    }

    function readHistory() {
      try {
        const items = JSON.parse(localStorage.getItem(historyKey) || "[]");
        return Array.isArray(items) ? items : [];
      } catch {
        return [];
      }
    }

    function renderHistory() {
      const items = readHistory();
      historyListEl.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.innerHTML =
          '<div class="history-empty-icon">${ICON_CHAT_BUBBLE}</div>' +
          '<div class="history-empty-title">No conversations yet</div>' +
          '<div class="history-empty-copy">Start a new chat to begin.</div>';
        historyListEl.appendChild(empty);
        return;
      }
      for (const [label, groupItems] of groupHistory(items)) {
        const group = document.createElement("div");
        group.className = "history-group";
        const heading = document.createElement("div");
        heading.className = "history-label";
        heading.textContent = label;
        group.appendChild(heading);
        for (const item of groupItems) {
          const row = document.createElement("button");
          row.className = "history-item";
          row.type = "button";
          row.innerHTML = "<span class='history-title'></span><span class='history-time'></span>";
          row.children[0].textContent = item.title || "Untitled";
          row.children[1].textContent = formatHistoryTime(item.createdAt);
          row.addEventListener("click", () => {
            promptEl.value = item.title || "";
            promptEl.focus();
          });
          group.appendChild(row);
        }
        historyListEl.appendChild(group);
      }
    }

    function groupHistory(items) {
      const today = [];
      const yesterday = [];
      const older = [];
      const startToday = new Date();
      startToday.setHours(0, 0, 0, 0);
      const startYesterday = startToday.getTime() - 86400000;
      for (const item of items) {
        if (item.createdAt >= startToday.getTime()) today.push(item);
        else if (item.createdAt >= startYesterday) yesterday.push(item);
        else older.push(item);
      }
      return [
        ["Today", today],
        ["Yesterday", yesterday],
        ["Previous", older],
      ].filter(([, groupItems]) => groupItems.length);
    }

    function formatHistoryTime(value) {
      const date = new Date(value);
      const startToday = new Date();
      startToday.setHours(0, 0, 0, 0);
      if (value >= startToday.getTime()) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }

    function setText(id, value) {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    }

    function createWelcome() {
      const wrapper = document.createElement("div");
      wrapper.className = "welcome";
      wrapper.id = "welcome";
      wrapper.innerHTML = ${JSON.stringify(WELCOME_INNER_HTML)};
      wrapper.querySelectorAll(".suggestion").forEach((button) => {
        button.addEventListener("click", () => {
          promptEl.value = (button.querySelector(".suggestion-text") ?? button).textContent.trim();
          promptEl.focus();
        });
      });
      return wrapper;
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
      if (request.method === "GET" && url.pathname === "/api/network") {
        const result = await fetchNetworkSummary(config);
        return sendJson(response, 200, result);
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
  if (["completed", "failed"].includes(submitted.status)) {
    return submitted;
  }
  return waitForChatJob(submitted.job_id, body, config, fetchImpl);
}

export async function submitChatJob(body, config = configFromEnv(), fetchImpl = fetch) {
  const message = String(body?.message ?? "").trim();
  if (!message) {
    throw httpError(400, "message is required");
  }

  const weatherLocation = extractWeatherLocation(message);
  if (weatherLocation) {
    return fetchWeatherJob(message, weatherLocation, config, fetchImpl);
  }

  const currentOfficeQuery = extractCurrentOfficeQuery(message);
  if (currentOfficeQuery) {
    const currentOfficeJob = await fetchCurrentOfficeJob(message, currentOfficeQuery, config, fetchImpl);
    if (currentOfficeJob) {
      return currentOfficeJob;
    }
  }

  const factualTopic = extractFactualSummaryTopic(message);
  if (factualTopic) {
    const factualJob = await fetchFactualSummaryJob(message, factualTopic, config, fetchImpl);
    if (factualJob) {
      return factualJob;
    }
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

async function fetchWeatherJob(message, location, config, fetchImpl) {
  const cacheKey = weatherCacheKey(location);
  let cacheHit = false;
  let output = null;

  if (config.weatherCacheUrl) {
    output = await redisGet(config.weatherCacheUrl, cacheKey);
    cacheHit = Boolean(output);
  }

  if (!output) {
    output = await fetchWeatherSummary(location, config, fetchImpl);
    if (config.weatherCacheUrl) {
      await redisSet(config.weatherCacheUrl, cacheKey, output, config.weatherTtlSeconds);
    }
  }

  return {
    job_id: `weather-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
    status: "completed",
    output,
    output_cleaned: false,
    error: null,
    model: "wttr.in",
    assigned_node_id: "weather-tool",
    execution_mode: "tool",
    graph_execution_enabled: false,
    tool: "weather",
    cache_hit: cacheHit,
    progress: {
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
      waiting: 0,
      processing: null,
      merging: false,
      strategy: "weather_tool",
    },
  };
}

export function extractWeatherLocation(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (!/\b(weather|forecast|temperature|temp)\b/.test(lower)) {
    return null;
  }

  const patterns = [
    /\b(?:weather|forecast|temperature|temp)\s+(?:in|for|at|of)\s+(.+)$/i,
    /\b(?:what(?:'s| is)?|how(?:'s| is)?)\s+(?:the\s+)?(?:weather|forecast|temperature|temp)(?:\s+like)?\s+(?:in|for|at|of)\s+(.+)$/i,
    /\b(?:weather|forecast|temperature|temp)\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const location = cleanWeatherLocation(match?.[1]);
    if (location) {
      return location;
    }
  }
  return null;
}

function cleanWeatherLocation(value) {
  let location = String(value ?? "")
    .replace(/[?!.,]+$/g, "")
    .replace(/\b(?:today|now|right now|currently|please|pls)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  location = location.replace(/^(?:the\s+)?weather\s+(?:in|for|at|of)\s+/i, "").trim();
  if (!location || location.length < 2 || location.length > 120) {
    return null;
  }
  return location;
}

async function fetchWeatherSummary(location, config, fetchImpl) {
  const url = `${config.weatherBaseUrl}/${encodeURIComponent(location)}?format=j1`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "MundusX-Chat/0.1 weather-router" },
  });
  if (!response.ok) {
    throw httpError(502, `weather lookup failed for ${location}`);
  }
  const payload = await response.json();
  return formatWeatherSummary(location, payload);
}

function formatWeatherSummary(requestedLocation, payload) {
  const current = payload?.current_condition?.[0];
  if (!current) {
    throw httpError(502, `weather lookup returned no current conditions for ${requestedLocation}`);
  }
  const area = payload?.nearest_area?.[0];
  const areaName = area?.areaName?.[0]?.value ?? requestedLocation;
  const region = area?.region?.[0]?.value ?? "";
  const country = area?.country?.[0]?.value ?? "";
  const place = [areaName, region, country].filter(Boolean).join(", ");
  const condition = current.weatherDesc?.[0]?.value ?? "current conditions";
  const tempC = current.temp_C;
  const tempF = current.temp_F;
  const feelsC = current.FeelsLikeC;
  const feelsF = current.FeelsLikeF;
  const humidity = current.humidity;
  const windKmph = current.windspeedKmph;
  const observation = current.localObsDateTime ? ` Observed ${current.localObsDateTime}.` : "";
  return `Weather for ${place}: ${condition}, ${tempC}C/${tempF}F, feels like ${feelsC}C/${feelsF}F, humidity ${humidity}%, wind ${windKmph} km/h.${observation}`;
}

export function extractCurrentOfficeQuery(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (!/\b(?:current|now|today|202\d|latest)\b/.test(lower)) {
    return null;
  }
  const match = lower.match(/\b(?:who\s+is\s+)?(?:the\s+)?current\s+president\s+of\s+(.+?)(?:\s+(?:today|now|currently|in\s+202\d|year\s+202\d))*[?.!]*$/i);
  if (!match) {
    return null;
  }
  const country = cleanCountryName(match[1]);
  const countryInfo = country ? countryEntityFor(country) : null;
  if (!countryInfo) {
    return null;
  }
  return {
    office: "president",
    relationProperty: "P6",
    country: countryInfo.name,
    countryEntityId: countryInfo.entityId,
  };
}

function cleanCountryName(value) {
  return String(value ?? "")
    .replace(/\b(?:today|now|currently|please|pls|year|in)\b/gi, "")
    .replace(/\b202\d\b/g, "")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countryEntityFor(country) {
  const key = String(country ?? "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const countries = new Map([
    ["usa", { name: "the United States", entityId: "Q30" }],
    ["us", { name: "the United States", entityId: "Q30" }],
    ["u s", { name: "the United States", entityId: "Q30" }],
    ["america", { name: "the United States", entityId: "Q30" }],
    ["united states", { name: "the United States", entityId: "Q30" }],
    ["united states of america", { name: "the United States", entityId: "Q30" }],
    ["philippines", { name: "the Philippines", entityId: "Q928" }],
    ["ph", { name: "the Philippines", entityId: "Q928" }],
  ]);
  return countries.get(key) ?? null;
}

async function fetchCurrentOfficeJob(message, query, config, fetchImpl) {
  try {
    const output = await fetchCurrentOfficeAnswer(query, config, fetchImpl);
    return {
      job_id: `facts-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
      status: "completed",
      output,
      output_cleaned: false,
      error: null,
      model: "wikidata",
      assigned_node_id: "facts-tool",
      execution_mode: "tool",
      graph_execution_enabled: false,
      tool: "current_office_holder",
      progress: {
        total: 0,
        completed: 0,
        running: 0,
        failed: 0,
        waiting: 0,
        processing: null,
        merging: false,
        strategy: "current_office_tool",
      },
    };
  } catch {
    return null;
  }
}

async function fetchCurrentOfficeAnswer(query, config, fetchImpl) {
  const country = await fetchWikidataEntity(query.countryEntityId, config, fetchImpl);
  const holderId = extractEntityClaimId(country, query.relationProperty);
  if (!holderId) {
    throw httpError(502, `current ${query.office} lookup returned no holder for ${query.country}`);
  }
  const holder = await fetchWikidataEntity(holderId, config, fetchImpl);
  const holderName = entityEnglishLabel(holder, holderId);
  return `Current ${query.office} of ${query.country}: ${holderName}. Source: Wikidata ${query.countryEntityId} ${query.relationProperty}.`;
}

async function fetchWikidataEntity(entityId, config, fetchImpl) {
  const url = `${config.wikidataEntityBaseUrl}/${encodeURIComponent(entityId)}.json`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "MundusX-Chat/0.1 factual-router" },
  });
  if (!response.ok) {
    throw httpError(502, `wikidata lookup failed for ${entityId}`);
  }
  const payload = await response.json();
  const entity = payload?.entities?.[entityId];
  if (!entity) {
    throw httpError(502, `wikidata lookup returned no entity for ${entityId}`);
  }
  return entity;
}

function extractEntityClaimId(entity, propertyId) {
  const claims = entity?.claims?.[propertyId] ?? [];
  const ranked = claims.find((claim) => claim.rank === "preferred") ?? claims.find((claim) => claim.rank !== "deprecated");
  const value = ranked?.mainsnak?.datavalue?.value;
  return typeof value?.id === "string" ? value.id : null;
}

function entityEnglishLabel(entity, fallback) {
  const labels = entity?.labels ?? {};
  return labels.en?.value ?? labels.mul?.value ?? labels["en-us"]?.value ?? labels["en-gb"]?.value ?? fallback;
}

export function extractFactualSummaryTopic(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (!/\b(history|who is|what is|tell me about|overview of|background of)\b/.test(lower)) {
    return null;
  }
  if (/\b(write|draft|create|generate|code|program|email|poem|story|summarize this|explain why)\b/.test(lower)) {
    return null;
  }

  const patterns = [
    /\b(?:give me|tell me|show me)?\s*(?:a\s+)?(?:brief\s+|detailed\s+)?history\s+of\s+(.+?)(?:\s+from\s+.+)?[?.!]*$/i,
    /\b(?:who|what)\s+is\s+(.+?)[?.!]*$/i,
    /\b(?:tell me about|overview of|background of)\s+(.+?)[?.!]*$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const topic = cleanFactualTopic(match?.[1]);
    if (topic) {
      return topic;
    }
  }
  return null;
}

function cleanFactualTopic(value) {
  const topic = String(value ?? "")
    .replace(/\b(?:today|now|please|pls|in detail|from its origins to today|from origins to today)\b/gi, "")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!topic || topic.length < 2 || topic.length > 100) {
    return null;
  }
  return topic;
}

async function fetchFactualSummaryJob(message, topic, config, fetchImpl) {
  try {
    const output = await fetchFactualSummary(topic, config, fetchImpl);
    return {
      job_id: `facts-${Date.now().toString(36)}-${hashText(message).slice(0, 10)}`,
      status: "completed",
      output,
      output_cleaned: false,
      error: null,
      model: "wikipedia-summary",
      assigned_node_id: "facts-tool",
      execution_mode: "tool",
      graph_execution_enabled: false,
      tool: "factual_summary",
      progress: {
        total: 0,
        completed: 0,
        running: 0,
        failed: 0,
        waiting: 0,
        processing: null,
        merging: false,
        strategy: "factual_summary_tool",
      },
    };
  } catch {
    return null;
  }
}

async function fetchFactualSummary(topic, config, fetchImpl) {
  const url = `${config.factualSummaryBaseUrl}/${encodeURIComponent(topic)}`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "MundusX-Chat/0.1 factual-router" },
  });
  if (!response.ok) {
    throw httpError(502, `factual lookup failed for ${topic}`);
  }
  const payload = await response.json();
  const title = payload.title ?? topic;
  const extract = String(payload.extract ?? "").trim();
  if (!extract || payload.type === "disambiguation") {
    throw httpError(502, `factual lookup returned no summary for ${topic}`);
  }
  const description = payload.description ? ` ${payload.description}.` : "";
  return `${title}:${description} ${extract}`.replace(/\s+/g, " ").trim();
}

function weatherCacheKey(location) {
  return `mundusx:weather:v1:${location.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

async function redisGet(redisUrl, key) {
  try {
    const result = await redisCommand(redisUrl, ["GET", key]);
    return typeof result === "string" && result.trim() ? result : null;
  } catch {
    return null;
  }
}

async function redisSet(redisUrl, key, value, ttlSeconds) {
  try {
    await redisCommand(redisUrl, ["SET", key, value, "EX", String(ttlSeconds)]);
  } catch {
    // Weather cache is optional; direct wttr.in lookup remains the source of truth.
  }
}

function redisCommand(redisUrl, args) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(redisUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const isTls = url.protocol === "rediss:";
    if (!["redis:", "rediss:", "valkey:", "valkeys:"].includes(url.protocol)) {
      reject(new Error("unsupported cache URL protocol"));
      return;
    }
    const socketFactory = isTls || url.protocol === "valkeys:" ? createTlsConnection : createConnection;
    const socket = socketFactory({
      host: url.hostname,
      port: Number(url.port || 6379),
      servername: url.hostname,
    });
    let buffer = Buffer.alloc(0);
    let settled = false;
    let expectedReplies = 1;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(1500, () => done(new Error("weather cache timed out")));
    socket.on("error", done);
    socket.on(isTls || url.protocol === "valkeys:" ? "secureConnect" : "connect", () => {
      const commands = [];
      if (url.password) {
        if (url.username) {
          commands.push(["AUTH", decodeURIComponent(url.username), decodeURIComponent(url.password)]);
        } else {
          commands.push(["AUTH", decodeURIComponent(url.password)]);
        }
      }
      commands.push(args);
      expectedReplies = commands.length;
      socket.write(commands.map(encodeRespArray).join(""));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseResp(buffer);
      if (parsed.complete && parsed.values.length >= expectedReplies) {
        const values = parsed.values;
        done(null, values[values.length - 1]);
      }
    });
  });
}

function encodeRespArray(values) {
  return `*${values.length}\r\n${values
    .map((value) => {
      const text = String(value);
      return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
    })
    .join("")}`;
}

function parseResp(buffer) {
  const values = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = parseRespValue(buffer, offset);
    if (!parsed) {
      return { complete: false };
    }
    values.push(parsed.value);
    offset = parsed.offset;
  }
  return { complete: values.length > 0, values, value: values.length === 1 ? values[0] : values };
}

function parseRespValue(buffer, offset) {
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) {
    return null;
  }
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  if (type === "+") {
    return { value: line, offset: lineEnd + 2 };
  }
  if (type === "-") {
    throw new Error(line);
  }
  if (type === ":") {
    return { value: Number(line), offset: lineEnd + 2 };
  }
  if (type === "$") {
    const length = Number(line);
    if (length < 0) {
      return { value: null, offset: lineEnd + 2 };
    }
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) {
      return null;
    }
    return { value: buffer.toString("utf8", start, end), offset: end + 2 };
  }
  return null;
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
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
  const parentStatus = String(job.status ?? "").toLowerCase();
  if (!nodes.length) {
    return {
      total: 0,
      completed: 0,
      running: ["assigned", "running"].includes(parentStatus) ? 1 : 0,
      failed: 0,
      waiting: parentStatus === "queued" ? 1 : 0,
      processing: ["assigned", "running"].includes(parentStatus)
        ? `Direct response${job.assigned_node_id ? ` on ${job.assigned_node_id}` : ""}`
        : null,
      merging: false,
      strategy: job.plan?.strategy ?? "single_job",
    };
  }

  const graphExecutionEnabled = Boolean(job.graph_execution_enabled);
  const singleDirectNode = !graphExecutionEnabled && nodes.length === 1;
  const effectiveNodes = singleDirectNode
    ? nodes.map((node) => ({
        ...node,
        status: parentStatus || node.status,
        assigned_node_id: node.assigned_node_id ?? job.assigned_node_id ?? null,
        completed_at: node.completed_at ?? job.completed_at ?? null,
        output: node.output ?? job.output ?? null,
      }))
    : nodes;

  const completed = effectiveNodes.filter((node) => node.status === "completed").length;
  const runningNodes = effectiveNodes.filter((node) => node.status === "running" || node.status === "assigned");
  const failed = effectiveNodes.filter((node) => node.status === "failed").length;
  const waiting = effectiveNodes.filter((node) => node.status === "waiting" || node.status === "ready" || node.status === "queued").length;
  const activeNode =
    effectiveNodes.find((node) => node.id === job.active_graph_node_id) ?? runningNodes[0] ?? null;
  const finalNodeId = graph.final_node_id ?? null;
  const merging =
    Boolean(activeNode) &&
    (activeNode.id === finalNodeId || String(activeNode.responsibility ?? "") === "merge");

  return {
    total: effectiveNodes.length,
    completed,
    running: runningNodes.length,
    failed,
    waiting,
    processing: activeNode?.name ?? null,
    merging,
    strategy: job.plan?.strategy ?? graph.strategy ?? "graph",
    nodes: effectiveNodes.map((node) => ({
      id: node.id,
      name: node.name,
      status: node.status,
      assigned_node_id: node.assigned_node_id ?? null,
      latency_ms: numberOrNull(node.latency_ms),
      queue_wait_ms: numberOrNull(node.queue_wait_ms),
      runtime_ms: numberOrNull(node.runtime_ms),
      output_chars: numberOrNull(node.output_chars),
      estimated_output_tokens: numberOrNull(node.estimated_output_tokens),
      effective_max_tokens: numberOrNull(node.effective_max_tokens),
      output: node.status === "completed" && node.output ? compactChunkOutput(node.output) : "",
    })),
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactChunkOutput(value) {
  const cleaned = cleanChatOutputInternal(value, false);
  if (isInstructionOnlyChunkOutput(cleaned)) {
    return "";
  }
  return truncateText(cleaned, 900);
}

function isInstructionOnlyChunkOutput(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return true;
  }
  const sentences = text.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean);
  if (!sentences.length) {
    return false;
  }
  const instructionSentences = sentences.filter((sentence) =>
    sentence.startsWith("do not ") ||
    sentence.startsWith("don't ") ||
    sentence.startsWith("avoid ") ||
    sentence.startsWith("return only ") ||
    sentence.startsWith("not include "),
  );
  return instructionSentences.length / sentences.length >= 0.75;
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trimEnd()}...`;
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
  if (
    containsAny(lower, [
      "one word",
      "one-word",
      "answer only",
      "only with",
      "final number",
      "just the number",
      "single sentence",
    ])
  ) {
    return 48;
  }
  if (containsAny(lower, ["detailed", "complete", "full", "comprehensive", "history of", "report"])) {
    return 1024;
  }
  if (message.length > 600) {
    return 768;
  }
  if (message.length <= 160) {
    return 128;
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

export async function fetchNetworkSummary(config = configFromEnv(), fetchImpl = fetch) {
  const started = Date.now();
  try {
    const status = await controlPlaneFetch(fetchImpl, config, "/v1/status");
    const snapshot = status.snapshot ?? status;
    return {
      status: "ok",
      control_plane_url: config.controlPlaneUrl,
      model_routing: "control-plane",
      latency_ms: Math.max(1, Date.now() - started),
      online_count: numberField(snapshot.online_count),
      trusted_count: numberField(snapshot.trusted_count),
      paused_count: numberField(snapshot.paused_count),
      queued_job_count: numberField(snapshot.queued_job_count),
      assigned_job_count: numberField(snapshot.assigned_job_count),
      completed_job_count: numberField(snapshot.completed_job_count),
      failed_job_count: numberField(snapshot.failed_job_count),
    };
  } catch (error) {
    return {
      status: "degraded",
      control_plane_url: config.controlPlaneUrl,
      model_routing: "control-plane",
      error: error.message ?? "network summary unavailable",
      latency_ms: Math.max(1, Date.now() - started),
      online_count: 0,
      trusted_count: 0,
      paused_count: 0,
      queued_job_count: 0,
      assigned_job_count: 0,
      completed_job_count: 0,
      failed_job_count: 0,
    };
  }
}

function numberField(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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
  return cleanChatOutputInternal(value, true);
}

function cleanChatOutputInternal(value, emptyFallback) {
  let output = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

  output = stripWorkerTrace(output);
  output = stripRolePrefixes(output);
  output = stripAssistantPreamble(output);
  output = stripEmbeddedRoleLeak(output);
  output = stripPromptInstructionLeak(output);
  output = collapseRepeatedSentences(output);
  output = collapseRepeatedLines(output);
  output = output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!output) {
    return emptyFallback ? "MundusX returned an empty response. Please try again." : "";
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
    const next = output.replace(/^(?:system|assistant|user|mundusx chat)\s*:\s*/i, "").trim();
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripAssistantPreamble(value) {
  return value
    .trim()
    .replace(
      /^(?:(?:certainly|sure|of course)[!.]?\s+)?(?:here(?:'s| is)\s+(?:a|an|the)?\s*(?:brief|detailed|complete)?\s*(?:answer|overview|summary|history|response|program|code)?(?:\s+of\s+[^:]{2,120})?\s*:\s*)/i,
      "",
    )
    .trim();
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

function stripPromptInstructionLeak(value) {
  let output = value.trim();
  if (!output) {
    return output;
  }

  const requiredOutputIndex = output.search(/\brequired output\s*:/i);
  if (requiredOutputIndex !== -1) {
    const afterRequiredOutput = output.slice(requiredOutputIndex);
    const headingPattern = /\b([A-Z][A-Za-z0-9 &,'-]{2,80})\s*:\s+(?=[A-Z0-9])/g;
    let match;
    while ((match = headingPattern.exec(afterRequiredOutput)) !== null) {
      const heading = match[1].trim().toLowerCase();
      if (!["required output", "name", "responsibility", "subject"].includes(heading)) {
        return afterRequiredOutput.slice(match.index).trim();
      }
    }
  }

  output = output.replace(
    /^(?:(?:do not|don't|avoid|never|return only|write only|only include)[^.!?\n]*[.!?]\s*){1,12}/i,
    "",
  ).trim();

  output = output.replace(
    /^(?:mundusx subjob|subject|name|responsibility)\s*:[\s\S]{0,700}?\brequired output\s*:\s*/i,
    "",
  ).trim();

  return output;
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
