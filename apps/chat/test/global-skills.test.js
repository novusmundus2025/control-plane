import test from "node:test";
import assert from "node:assert/strict";
import { createGlobalSkillsController } from "../src/features/skills/control-plane.js";
import { selectChatSkills } from "../src/main.js";
import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";

const token = "test-control-plane-token-".repeat(3);
test("database migration permits only disabled empty global drafts",async()=>{
  const db=new PGlite();
  try {
    await db.exec("create table users(id uuid primary key)");
    for(const name of ["0027_user_and_global_skills.sql","0035_disabled_global_skill_drafts.sql"])
      await db.exec(readFileSync(new URL("../../../db/migrations/"+name,import.meta.url),"utf8"));
    await db.exec("insert into global_skill_overrides(skill_id,content,enabled) values('security','',false)");
    await assert.rejects(db.exec("update global_skill_overrides set enabled=true where skill_id='security'"));
    await db.exec("update global_skill_overrides set content='# Security\nProtect data.', enabled=true where skill_id='security'");
  } finally {await db.close();}
});
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

test("blank disabled drafts are allowed, but empty instructions cannot be enabled", async () => {
  const blank = fixture({ id: "router", content: "", enabled: false });
  await blank.call("PUT");
  assert.equal(blank.writes[0][2].enabled, false);
  for (const content of ["", "# Empty heading"]) {
    const enabled = fixture({ id:"router", content, enabled:true });
    await assert.rejects(enabled.call("PUT"), {statusCode:400});
    assert.equal(enabled.writes.length,0);
  }
});

test("every global Markdown slot respects its independent enabled override", () => {
  for (const id of ["router", "formatter", "persona-atlas", "translation", "code", "math", "weather", "facts", "chunk-planner", "verifier", "security", "guardrails", "rag-integration", "model-provider"]) {
    const messages=["Who are you?", "Translate to German", "Calculate 2+2", "Write a complete Python program", "What is the weather?", "Who is the current president?"];
    const off=[{skill_id:id,content:"# Example\nExample instructions",enabled:false}];
    for(const message of messages) assert.ok(!selectChatSkills(message,off).some(skill=>skill.name===id+".md"));
    const on=[{...off[0],enabled:true}];
    assert.ok(messages.some(message=>selectChatSkills(message,on).some(skill=>skill.name===id+".md")), id+" can be enabled");
  }
});
