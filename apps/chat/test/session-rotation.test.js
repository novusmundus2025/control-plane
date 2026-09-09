import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { page } from "../src/main.js";

const html = page();
test("project submissions use the current CSRF cookie after another tab rotates the session", async () => {
  const calls = [];
  const document = { cookie: "__Host-mx_csrf=first" };
  const window = { fetch: async (...args) => { calls.push(args); return { ok: true }; } };
  const context = vm.createContext({ window, document, Headers, authCsrfToken: "stale" });
  vm.runInContext(html.slice(html.indexOf("    const nativeFetch ="), html.indexOf("    async function bootstrapAuthentication()")), context);
  await window.fetch("/api/agent/tasks", { method: "POST", headers: new Headers({ "Content-Type": "application/json" }) });
  document.cookie = "other=value; __Host-mx_csrf=rotated";
  await window.fetch("/api/agent/tasks", { method: "POST" });
  assert.equal(calls[0][1].headers.get("X-MundusX-CSRF"), "first");
  assert.equal(calls[0][1].headers.get("Content-Type"), "application/json");
  assert.equal(calls[1][1].headers.get("X-MundusX-CSRF"), "rotated");
  document.cookie = "";
  await window.fetch("/api/agent/tasks", { method: "POST" });
  assert.equal(calls[2][1].headers.has("X-MundusX-CSRF"), false);
  await window.fetch("https://other.example/api/tasks", { method: "POST" });
  assert.equal(calls[3][1].headers, undefined);
  assert.equal(calls.length, 4, "requests are never automatically replayed");
});

test("failed submissions survive cache restoration with a retry action", () => {
  let saved;
  let retried;
  const body = { textContent: "" };
  const node = { querySelector: () => body };
  const context = vm.createContext({
    conversationStreamStates: new Map(),
    appendCachedConversationTurn: (id, turn) => { saved = turn; },
    renderConversationStreamState() {},
    addMessage: () => node,
    appendRetryAction: (element, prompt) => { retried = prompt; },
  });
  vm.runInContext(html.slice(html.indexOf("    function failConversationStream("), html.indexOf("    async function readApiPayload(")), context);
  vm.runInContext(html.slice(html.indexOf("    function renderStoredTurn("), html.indexOf("    function appendCachedConversationTurn(")), context);
  context.failConversationStream("conversation", node, "Build my frontend", new Error("CSRF validation failed"));
  context.renderStoredTurn(saved);
  assert.equal(body.textContent, "CSRF validation failed");
  assert.equal(node.className, "message error");
  assert.equal(retried, "Build my frontend");
});
