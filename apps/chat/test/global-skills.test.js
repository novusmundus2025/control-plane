import test from "node:test";
import assert from "node:assert/strict";
import { createGlobalSkillsController } from "../src/features/skills/control-plane.js";

const token = "test-control-plane-token-".repeat(3);
function fixture(body = {}) {
  const output = [], writes = [];
  const handle = createGlobalSkillsController({
    token,
    registry: { catalog: () => [{ id: "router", title: "Router", enabled: true }], rawContent: () => "# Router\nChoose tools.", has: id => id === "router" },
    authStore: { globalSkillOverrides: async () => [], saveControlPlaneGlobalSkill: async (...args) => { writes.push(args); return { skill_id: args[1] }; } },
    readJsonBody: async () => body,
    sendJson: (_response, status, body) => output.push({ status, body }),
  });
  return { output, writes, call: (method, credential = token) => handle({ request: { method, headers: { authorization: `Bearer ${credential}` } }, response: {}, url: new URL("https://chat.example/internal/control-plane/skills") }) };
}
test("global skill service requires server authentication for both reading and writing", async () => {
  const f = fixture();
  for (const method of ["GET", "PUT"]) {
    await assert.rejects(f.call(method, ""), { statusCode: 401 });
    await assert.rejects(f.call(method, "x".repeat(token.length)), { statusCode: 401 });
  }
  assert.equal(f.writes.length, 0);
});
test("authenticated catalog returns the actual bundled Markdown", async () => {
  const f = fixture(); await f.call("GET");
  assert.equal(f.output[0].body.system[0].content, "# Router\nChoose tools.");
});
test("global writes validate Markdown and retain the verified actor for audit", async () => {
  const invalid = fixture({ id: "router", content: "" });
  await assert.rejects(invalid.call("PUT"), { statusCode: 400 });
  assert.equal(invalid.writes.length, 0);
  const f = fixture({ id: "router", content: "# Router\nChoose tools.", enabled: false, actor: "admin@example.com" });
  await f.call("PUT");
  assert.deepEqual(f.writes[0], ["admin@example.com", "router", { content: "# Router\nChoose tools.", enabled: false }]);
});
