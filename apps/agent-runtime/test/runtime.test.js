import test from "node:test";
import assert from "node:assert/strict";

import { createDeepAgentsRuntime, selectAgentRuntime } from "../src/index.js";

const IDS = {
  task_id: "123e4567-e89b-42d3-a456-426614174000",
  session_id: "223e4567-e89b-42d3-a456-426614174000",
  user_id: "323e4567-e89b-42d3-a456-426614174000",
};

test("runtime selection prefers advertised Deep Agents and preserves native fallback", () => {
  assert.equal(selectAgentRuntime("auto", { agent_runtimes: ["native", "deepagents"] }), "deepagents");
  assert.equal(selectAgentRuntime("auto", {}), "native");
  assert.equal(selectAgentRuntime("native", {}), "native");
  assert.throws(() => selectAgentRuntime("deepagents", {}), /does not advertise/);
});

test("Deep Agents runtime binds MundusX authority and session identity", async () => {
  let agentOptions;
  let invocation;
  let toolContext;
  const events = [];
  const runtime = createDeepAgentsRuntime({
    model: { provider: "mundusx" },
    createTools(context) { toolContext = context; return [{ name: "file_read" }]; },
    agentFactory: async (options) => {
      agentOptions = options;
      return {
        async invoke(input, config) {
          invocation = { input, config };
          return { messages: [{ role: "assistant", content: "Repository inspected." }] };
        },
      };
    },
  });
  const result = await runtime.run({
    ...IDS,
    prompt: "inspect this repository",
    authority: { repository_source_id: "local:user:repo", allowed_operations: ["file.read"] },
  }, { emit: async (event) => events.push(event) });

  assert.equal(agentOptions.tools[0].name, "file_read");
  assert.equal(toolContext.allowMutations, false);
  assert.equal(toolContext.authority.repository_source_id, "local:user:repo");
  assert.equal(invocation.config.configurable.thread_id, IDS.session_id);
  assert.equal(invocation.config.metadata.mundusx_user_id, IDS.user_id);
  assert.equal(result.output, "Repository inspected.");
  assert.deepEqual(events.map((event) => event.type), ["runtime.started", "runtime.completed"]);
});

test("Deep Agents runtime refuses tasks without an authority envelope", async () => {
  const runtime = createDeepAgentsRuntime({ model: {}, agentFactory: async () => ({ invoke() {} }) });
  await assert.rejects(runtime.run({ ...IDS, prompt: "inspect" }), /require MundusX tool authority/);
});
