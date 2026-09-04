import test from "node:test";
import assert from "node:assert/strict";

import { createLocalAgentHttpController } from "../src/features/agent/http-controller.js";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";

function controllerFixture(overrides = {}) {
  let rendered;
  const calls = [];
  const authStore = {
    async mcpSession() { return { id: "connector-user" }; },
    async session() { return { id: "browser-user" }; },
    requireCsrf() { calls.push(["csrf"]); },
    async authorizeConversation(...args) { calls.push(["conversation", ...args]); },
    async registerLocalAgent(...args) { calls.push(["register", ...args]); return { connection_id: TASK_ID }; },
    async claimLocalAgentTask(...args) { calls.push(["claim", ...args]); return null; },
    async heartbeatLocalAgentTask(...args) { calls.push(["heartbeat", ...args]); return { state: "cancelled" }; },
    async appendLocalAgentEvents(...args) { calls.push(["events", ...args]); return { accepted: 1 }; },
    async completeLocalAgentTask(...args) { calls.push(["complete", ...args]); return { state: "completed" }; },
    async localAgentStatus(...args) { calls.push(["status", ...args]); return { online: true }; },
    async createLocalAgentTask(...args) { calls.push(["create", ...args]); return { task_id: TASK_ID }; },
    async localAgentTask(...args) { calls.push(["task", ...args]); return { task_id: TASK_ID, state: "running" }; },
    async localAgentSessions(...args) { calls.push(["sessions", ...args]); return { sessions: [] }; },
    async resumeLocalAgentSession(...args) { calls.push(["resume", ...args]); return { task_id: TASK_ID }; },
    async cancelLocalAgentTask(...args) { calls.push(["cancel", ...args]); return { state: "cancelled" }; },
    ...overrides,
  };
  return {
    calls,
    controller: createLocalAgentHttpController({
      authStore,
      readJsonBody: async (request) => request.body || {},
      sendJson: (_response, status, payload) => { rendered = { status, payload }; },
    }),
    rendered: () => rendered,
  };
}

test("connector claims work with the MCP token identity", async () => {
  const fixture = controllerFixture();
  const handled = await fixture.controller({
    request: { method: "POST", body: { connection_id: TASK_ID } },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/agent/connector/tasks/next"),
  });
  assert.equal(handled, true);
  assert.deepEqual(fixture.calls[0], ["claim", "connector-user", TASK_ID]);
  assert.deepEqual(fixture.rendered(), { status: 200, payload: { task: null } });
});

test("connector heartbeat exposes cancellation state", async () => {
  const fixture = controllerFixture();
  await fixture.controller({
    request: { method: "POST", body: { connection_id: TASK_ID } },
    response: {},
    url: new URL(`https://chat.mundusx.ai/api/agent/connector/tasks/${TASK_ID}/heartbeat`),
  });
  assert.deepEqual(fixture.calls[0], ["heartbeat", "connector-user", TASK_ID, TASK_ID]);
  assert.equal(fixture.rendered().payload.state, "cancelled");
});

test("browser task submission is session, CSRF, and conversation scoped", async () => {
  const fixture = controllerFixture();
  await fixture.controller({
    request: { method: "POST", body: { prompt: "inspect this repository", conversation_id: TASK_ID } },
    response: {},
    url: new URL("https://chat.mundusx.ai/api/agent/tasks"),
  });
  assert.deepEqual(fixture.calls.map((call) => call[0]), ["csrf", "conversation", "create"]);
  assert.equal(fixture.calls[1][1], "browser-user");
  assert.equal(fixture.rendered().status, 202);
});

test("connector endpoints reject missing MCP credentials", async () => {
  const fixture = controllerFixture({ async mcpSession() { return null; } });
  await assert.rejects(
    fixture.controller({
      request: { method: "POST", body: { connection_id: TASK_ID } },
      response: {},
      url: new URL("https://chat.mundusx.ai/api/agent/connector/tasks/next"),
    }),
    (error) => error.statusCode === 401,
  );
});

test("browser session listing and resume stay user and CSRF scoped", async () => {
  const fixture = controllerFixture();
  await fixture.controller({ request: { method: "GET" }, response: {}, url: new URL("https://chat.mundusx.ai/api/agent/sessions") });
  assert.deepEqual(fixture.calls[0], ["sessions", "browser-user"]);
  await fixture.controller({ request: { method: "POST", body: { prompt: "continue" } }, response: {}, url: new URL(`https://chat.mundusx.ai/api/agent/sessions/${TASK_ID}/resume`) });
  assert.deepEqual(fixture.calls.slice(1).map((call) => call[0]), ["csrf", "resume"]);
  assert.equal(fixture.calls[2][1], "browser-user");
  assert.equal(fixture.calls[2][2], TASK_ID);
});
