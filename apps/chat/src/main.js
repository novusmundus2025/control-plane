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
    weatherCacheUrl: (
      env.MUNDUSX_WEATHER_CACHE_URL ??
      env.VALKEY_URL ??
      env.REDIS_URL ??
      ""
    ).trim(),
    weatherBaseUrl: normalizeOrigin(env.MUNDUSX_WEATHER_URL ?? DEFAULT_WEATHER_URL),
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
    .history-title {
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
    :root {
      color-scheme: dark;
      --mx-bg: #050505;
      --mx-panel: #090909;
      --mx-panel-soft: #111111;
      --mx-line: rgba(255,255,255,0.22);
      --mx-line-strong: rgba(255,255,255,0.72);
      --mx-text: #f4f4f0;
      --mx-muted: #aaa9a3;
      --mx-green: #18d97a;
    }
    body {
      background:
        radial-gradient(circle at 50% 32%, rgba(255,255,255,0.055), transparent 32%),
        linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px),
        linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
        var(--mx-bg);
      background-size: auto, 48px 48px, 48px 48px, auto;
      color: var(--mx-text);
      font-family: "Courier New", Consolas, "Lucida Console", monospace;
      overflow: hidden;
    }
    .shell {
      height: 100vh;
      min-height: 0;
      grid-template-columns: 372px minmax(0, 1fr);
      border: 0;
      background: transparent;
      font-family: "Courier New", Consolas, "Lucida Console", monospace;
    }
    aside {
      height: 100vh;
      min-height: 0;
      padding: 28px 26px;
      border-right: 1px solid var(--mx-line);
      background: rgba(0,0,0,0.78);
      color: var(--mx-text);
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      gap: 22px;
    }
    .brand-block {
      grid-template-columns: 68px minmax(0,1fr);
      gap: 16px;
      padding: 0;
    }
    .brand-block .brand-logo {
      width: 64px;
      height: 64px;
      filter: grayscale(1) brightness(0) invert(1);
    }
    .brand-name {
      font-size: 28px;
      letter-spacing: 1px;
      color: #fff;
    }
    .brand-kicker {
      margin-top: 10px;
      color: var(--mx-muted);
      font-size: 13px;
      letter-spacing: 1.2px;
    }
    .network-summary {
      position: relative;
      display: flex;
      align-items: center;
      min-height: 34px;
      color: var(--mx-muted);
      font-size: 14px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }
    .network-summary::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -9px;
      height: 1px;
      background: linear-gradient(90deg, rgba(255, 153, 51, 0.95), rgba(255, 153, 51, 0.36), transparent);
      box-shadow: 0 0 16px rgba(255, 153, 51, 0.28);
    }
    .network-summary.is-online::after {
      background: linear-gradient(90deg, rgba(31, 227, 125, 0.95), rgba(31, 227, 125, 0.28), transparent);
      box-shadow: 0 0 16px rgba(31, 227, 125, 0.22);
    }
    .network-summary.is-offline::after {
      background: linear-gradient(90deg, rgba(255, 80, 80, 0.95), rgba(255, 80, 80, 0.28), transparent);
      box-shadow: 0 0 16px rgba(255, 80, 80, 0.22);
    }
    .network-signal {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      gap: 8px;
    }
    .online-dot,
    .network-dot {
      display: inline-block;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--mx-green);
      margin-right: 8px;
      border: 0;
    }
    .network-summary .online-dot {
      flex: 0 0 auto;
      margin-right: 0;
      background: #ff9933;
      box-shadow: 0 0 14px rgba(255, 153, 51, 0.48);
    }
    .network-summary.is-online .online-dot {
      background: var(--mx-green);
      box-shadow: 0 0 14px rgba(31, 227, 125, 0.36);
    }
    .network-summary.is-offline .online-dot {
      background: #ff5050;
      box-shadow: 0 0 14px rgba(255, 80, 80, 0.34);
    }
    .new-chat {
      height: 58px;
      min-height: 58px;
      border: 1px solid var(--mx-line-strong);
      border-radius: 0;
      background: rgba(255,255,255,0.025);
      color: #fff;
      box-shadow: inset 0 0 22px rgba(255,255,255,0.025);
      justify-content: space-between;
      padding: 0 20px;
      font-size: 16px;
      text-transform: none;
    }
    .rail-list {
      gap: 18px;
      padding: 0 6px 0 0;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .history-group {
      border-top: 1px solid var(--mx-line);
      padding-top: 12px;
      gap: 4px;
    }
    .history-label {
      color: var(--mx-muted);
      font-size: 14px;
      letter-spacing: 0.5px;
    }
    .history-item {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--mx-text);
      padding: 10px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      overflow: hidden;
      white-space: normal;
      text-align: left;
      font-size: 15px;
    }
    .history-title {
      display: block;
      flex: 1 1 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-item:hover,
    .history-item:focus-visible {
      background: rgba(255,255,255,0.1);
      outline: 0;
    }
    .history-time {
      color: var(--mx-muted);
      flex: 0 1 54px;
      min-width: 0;
      max-width: 54px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 13px;
      white-space: nowrap;
    }
    .history-empty {
      border-top: 1px solid var(--mx-line);
      padding-top: 14px;
      color: var(--mx-muted);
      font-size: 14px;
    }
    .rail-footer,
    .account-card {
      border: 1px solid var(--mx-line);
      color: var(--mx-text);
      padding: 16px;
      background: rgba(255,255,255,0.018);
      box-shadow: none;
    }
    .network-line {
      font-size: 14px;
      letter-spacing: 0.3px;
    }
    .network-line span:last-child {
      color: var(--mx-green);
    }
    .account-card {
      display: none;
    }
    .avatar-chip {
      width: 54px;
      height: 54px;
      border: 1px solid var(--mx-line-strong);
      background: rgba(255,255,255,0.055);
    }
    .account-name {
      color: #fff;
      text-transform: none;
    }
    .account-role {
      color: var(--mx-muted);
      text-transform: none;
    }
    main {
      height: 100vh;
      min-height: 0;
      background:
        linear-gradient(rgba(0,0,0,0.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,0,0,0.014) 1px, transparent 1px),
        #f8f8f4;
      background-size: 44px 44px;
      color: #111111;
      grid-template-rows: 68px minmax(0, 1fr) auto;
    }
    header {
      height: 68px;
      border-bottom: 1px solid rgba(0,0,0,0.08);
      background: rgba(248,248,244,0.96);
      padding: 0 30px;
    }
    .chat-title {
      color: #111111;
      font-size: 19px;
      font-weight: 800;
    }
    .header-actions {
      display: none;
    }
    .runtime-status-sentinel {
      display: none;
    }
    .settings-button {
      width: auto;
      height: 44px;
      border: 1px solid rgba(0,0,0,0.22);
      border-radius: 0;
      background: rgba(255,255,255,0.72);
      color: #111111;
      padding: 0 16px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .status {
      border: 1px solid rgba(0,0,0,0.22);
      color: #111111;
      background: rgba(255,255,255,0.72);
      border-radius: 0;
      font-size: 14px;
      padding: 12px 16px;
    }
    .dot {
      background: var(--mx-green);
      border-radius: 50%;
    }
    .messages {
      min-height: 0;
      overflow: auto;
      background: transparent;
    }
    .conversation {
      width: min(980px, calc(100% - 48px));
      min-height: 100%;
      padding: 56px 0 28px;
      gap: 22px;
    }
    .welcome {
      min-height: 58vh;
      color: #111111;
    }
    .welcome-inner {
      width: min(720px, 100%);
      gap: 22px;
    }
    h1 {
      color: #111111;
      font-size: clamp(36px, 4vw, 44px);
      letter-spacing: 0.5px;
      text-transform: none;
      font-weight: 800;
    }
    .welcome-copy {
      width: min(560px,100%);
      color: #484848;
      font-size: 18px;
      line-height: 1.55;
    }
    .tip-box {
      display: none;
    }
    .welcome-rule {
      width: 22px;
      height: 1px;
      background: rgba(0,0,0,0.38);
    }
    .examples-heading {
      width: min(650px, 100%);
      color: #5a5a5a;
      font-size: 14px;
      letter-spacing: 1px;
    }
    .examples-heading::before,
    .examples-heading::after {
      border-top: 1px solid rgba(0,0,0,0.24);
    }
    .suggestions {
      width: min(650px,100%);
      gap: 0;
    }
    .suggestion {
      border: 0;
      border-top: 1px solid rgba(0,0,0,0.18);
      border-radius: 0;
      padding: 20px 8px;
      background: transparent;
      color: #111111;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 16px;
      font-size: 16px;
    }
    .suggestion:last-child {
      border-bottom: 1px solid rgba(0,0,0,0.18);
    }
    .suggestion:hover {
      background: rgba(0,0,0,0.045);
    }
    .message {
      color: #111111;
      display: flex;
      align-items: flex-start;
      grid-template-columns: none;
      gap: 0;
      padding: 0;
    }
    .avatar {
      display: none;
    }
    .message.user {
      justify-content: flex-end;
    }
    .message-body {
      color: #111111;
      max-width: min(760px, 78%);
      padding: 14px 16px;
      line-height: 1.62;
    }
    .message.user .message-body {
      max-width: min(680px, 72%);
      background: #ededeb;
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 18px 18px 4px 18px;
    }
    .message.assistant .message-body {
      border-left: 0;
      background: rgba(255,255,255,0.86);
      border: 1px solid rgba(0,0,0,0.09);
      border-radius: 18px 18px 18px 4px;
      max-height: none;
      box-shadow: 0 14px 40px rgba(0,0,0,0.04);
    }
    .message.error .message-body {
      color: #8a0d0d;
      background: #fff1f1;
      border-color: rgba(138,13,13,0.2);
    }
    .work-trace {
      display: grid;
      gap: 12px;
    }
    .work-title {
      color: #111111;
      font-weight: 800;
    }
    .chunk-list {
      display: grid;
      gap: 8px;
    }
    .chunk-row {
      border: 1px solid rgba(0,0,0,0.12);
      background: rgba(0,0,0,0.018);
      padding: 10px 12px;
    }
    .chunk-row.is-active {
      border-color: rgba(0,0,0,0.28);
      background: rgba(0,0,0,0.045);
    }
    .chunk-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      color: #111111;
    }
    .chunk-status {
      color: #5a5a5a;
      font-size: 12px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .chunk-status.is-active {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #111111;
    }
    .chunk-meta {
      margin-top: 6px;
      color: #626262;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .mx-spinner {
      width: 12px;
      height: 12px;
      border: 1px solid rgba(0,0,0,0.22);
      border-top-color: #111111;
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
    @keyframes mx-spin {
      to { transform: rotate(360deg); }
    }
    @keyframes mx-dot {
      0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
      40% { opacity: 1; transform: translateY(-2px); }
    }
    .chunk-output {
      margin-top: 9px;
      color: #333333;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 160px;
      overflow: auto;
      border-top: 1px solid rgba(0,0,0,0.12);
      padding-top: 9px;
      font-size: 13px;
    }
    .source-chunks {
      margin-top: 16px;
      border-top: 1px solid rgba(0,0,0,0.12);
      padding-top: 12px;
    }
    .source-chunks summary {
      cursor: pointer;
      color: #4a4a4a;
    }
    .meta,
    .fine-print {
      color: #626262;
    }
    form {
      width: min(1100px, calc(100% - 60px));
      padding: 0 0 30px;
      background: transparent;
    }
    .composer {
      border: 1px solid rgba(0,0,0,0.22);
      border-radius: 0;
      background: rgba(255,255,255,0.94);
      box-shadow: 0 18px 50px rgba(0,0,0,0.08);
      grid-template-columns: minmax(0,1fr) 64px;
      padding: 18px 16px;
    }
    .composer::before,
    .composer::after {
      display: none;
    }
    textarea {
      color: #111111;
      min-height: 54px;
      font-size: 17px;
      padding: 8px 6px;
    }
    textarea::placeholder {
      color: #737373;
    }
    .composer-actions {
      color: #626262;
      text-transform: none;
      font-size: 14px;
    }
    .send {
      width: 64px;
      height: 52px;
      border: 1px solid #111111;
      border-radius: 0;
      background: #111111;
      color: #fff;
    }
    .model-pill {
      display: none;
      border: 1px solid rgba(0,0,0,0.16);
      border-radius: 0;
      background: transparent;
      color: #5a5a5a;
      padding: 6px 8px;
      font-size: 12px;
    }
    @media (max-width: 920px) {
      .shell { grid-template-columns: 1fr; }
      aside { display: none; }
      main { grid-template-rows: 72px minmax(0,1fr) auto; }
      .conversation { width: calc(100% - 28px); padding-top: 42px; }
      form { width: calc(100% - 28px); padding-bottom: 18px; }
      .settings-button,
      .model-pill { display: none; }
    }
  </style>
</head>
<body>
  <div class="shell" data-control-plane="${escapeHtml(config.controlPlaneUrl)}">
    <aside>
      <div class="brand-block">
        <img class="brand-logo" src="/assets/mundusx-logo.png" alt="" />
        <div>
          <div class="brand-name">MUNDUSX</div>
          <div class="brand-kicker">DECENTRALIZED AI NETWORK</div>
        </div>
      </div>
      <div class="network-summary">
        <span class="network-signal"><i class="online-dot"></i><span id="network-state">Checking network</span></span>
      </div>
      <button class="new-chat" id="new-chat" type="button"><span>+ New Chat</span><span>Ctrl + K</span></button>
      <div class="rail-list" id="history-list" aria-label="Conversation history"></div>
      <div class="rail-footer">
        <div class="network-line"><span><span class="network-dot"></span>MundusX Network</span><span id="network-card-state">Syncing</span></div>
        <div id="network-card-metrics">-- nodes - -- queued - routed</div>
        <div>Latency <span id="network-latency">-- ms</span> - Jobs <span id="network-jobs">--</span></div>
      </div>
    </aside>
    <main>
      <header>
        <div class="chat-title">MundusX Chat</div>
        <span class="runtime-status-sentinel" id="runtime-status">Ready</span>
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
        promptEl.value = (button.querySelector("span:last-child") ?? button).textContent.trim();
        promptEl.focus();
      });
    });

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

        renderCompletedJob(pending, payload);
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
      body.textContent = "";
      body.appendChild(createWorkTrace(payload));
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatJobMeta(payload);
      body.appendChild(meta);
    }

    function renderCompletedJob(node, payload) {
      const body = node.querySelector(".message-body");
      body.textContent = payload.output || "(empty response)";
      if (payload.progress?.nodes?.some((chunk) => chunk.output)) {
        body.appendChild(createSourceChunks(payload));
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatJobMeta(payload);
      body.appendChild(meta);
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
        empty.textContent = "No conversations yet.";
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
      wrapper.innerHTML = '<div class="welcome-inner"><h1>Welcome to MundusX Chat</h1><div class="welcome-rule"></div><p class="welcome-copy">Ask anything about MundusX - contributors, architecture, nodes, jobs, or anything else.</p><div class="examples-heading"><span>Example Questions</span></div><div class="suggestions"><button class="suggestion" type="button"><span>-&gt;</span><span>Give me a detailed history of Honda from its origins to today.</span></button><button class="suggestion" type="button"><span>-&gt;</span><span>Explain why a CUDA node can claim a job and fail.</span></button><button class="suggestion" type="button"><span>-&gt;</span><span>Draft a product description for MundusX contributors.</span></button><button class="suggestion" type="button"><span>-&gt;</span><span>Summarize the current control-plane architecture.</span></button></div></div>';
      wrapper.querySelectorAll(".suggestion").forEach((button) => {
        button.addEventListener("click", () => {
          promptEl.value = (button.querySelector("span:last-child") ?? button).textContent.trim();
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
