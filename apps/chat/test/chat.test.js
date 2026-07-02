import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanChatOutput,
  configFromEnv,
  escapeHtml,
  fetchNetworkSummary,
  page,
  pollChatJob,
  submitChatJob,
} from "../src/main.js";

test("renders a usable chat page", () => {
  const html = page(
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai/",
      MUNDUSX_CHAT_TIMEOUT_SECONDS: "45",
    }),
  );

  assert.match(html, /MundusX Chat/);
  assert.match(html, /Welcome to MundusX Chat/);
  assert.match(html, /id="chat-form"/);
  assert.match(html, /id="history-list"/);
  assert.match(html, /id="network-state"/);
  assert.match(html, /Message MundusX/);
  assert.match(html, /\[ \/ \] Commands/);
  assert.match(html, /\.message\.assistant \.message-body/);
  assert.match(html, /\/assets\/mundusx-logo\.png/);
  assert.match(html, /uat\.mundusx\.ai/);
  assert.match(html, /Control-plane routed/);
  assert.doesNotMatch(html, /Qwen\/Test/);
  assert.doesNotMatch(html, /Honda history draft|Dave Batalla|57 nodes/);
  assert.match(html, /MundusX may produce inaccurate information/);
});

test("normalizes chat app environment", () => {
  const config = configFromEnv({
    PORT: "3010",
    MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai///",
    MUNDUSX_OPERATOR_TOKEN: " token ",
  });

  assert.equal(config.port, 3010);
  assert.equal(config.controlPlaneUrl, "https://uat.mundusx.ai");
  assert.equal(config.operatorToken, "token");
  assert.equal(config.modelOverride, "");
});

test("accepts an explicit chat model override without making it a default", () => {
  const config = configFromEnv({
    MUNDUSX_CHAT_MODEL: " Qwen/Explicit ",
  });

  assert.equal(config.modelOverride, "Qwen/Explicit");
});

test("escapes runtime values rendered into html", () => {
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
});

test("summarizes live control-plane network counts", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "https://uat.mundusx.ai/v1/status");
    return jsonResponse({
      online_count: 3,
      trusted_count: 2,
      paused_count: 1,
      queued_job_count: 4,
      assigned_job_count: 5,
      completed_job_count: 6,
      failed_job_count: 1,
    });
  };

  const result = await fetchNetworkSummary(
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.online_count, 3);
  assert.equal(result.queued_job_count, 4);
  assert.equal(result.model_routing, "control-plane");
});

test("submits chat work as an auto execution job", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs");
    const body = JSON.parse(init.body);
    assert.equal(body.prompt, "Give me a detailed history of Honda.");
    assert.equal(body.execution_mode, "auto");
    assert.equal(body.preferred_backend, "auto");
    assert.equal(body.model, undefined);
    assert.equal(body.max_tokens, 1024);
    assert.match(body.system_prompt, /Do not echo system/);
    return jsonResponse({
      job_id: "job-1",
      status: "queued",
      job: {
        job_id: "job-1",
        status: "queued",
        model: "Qwen/Test",
        execution_mode: "auto",
        graph_execution_enabled: true,
        plan: { strategy: "sectioned_research" },
        graph: {
          nodes: [
            { id: "job.origins", name: "Origins", status: "ready" },
            { id: "job.final", name: "Final synthesis", status: "waiting", responsibility: "merge" },
          ],
          final_node_id: "job.final",
        },
      },
    });
  };

  const result = await submitChatJob(
    { message: "Give me a detailed history of Honda." },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.length, 1);
  assert.equal(result.job_id, "job-1");
  assert.equal(result.execution_mode, "auto");
  assert.equal(result.progress.total, 2);
  assert.equal(result.progress.waiting, 2);
});

test("sends an explicit model override when configured", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "Qwen/Explicit");
    return jsonResponse({
      job_id: "job-2",
      job: {
        job_id: "job-2",
        status: "queued",
        model: "Qwen/Explicit",
        execution_mode: "auto",
        graph: { nodes: [] },
      },
    });
  };

  const result = await submitChatJob(
    { message: "Say hi." },
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai",
      MUNDUSX_CHAT_MODEL: "Qwen/Explicit",
    }),
    fetchImpl,
  );

  assert.equal(result.model, "Qwen/Explicit");
});

test("polls chat job progress and final cleaned output", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "https://uat.mundusx.ai/v1/jobs/job-1");
    return jsonResponse({
      job: {
        job_id: "job-1",
        status: "completed",
        model: "Qwen/Test",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        active_graph_node_id: "job.final",
        output: "llama.cpp mode=cuda; response=assistant: Done. Done.",
        graph: {
          final_node_id: "job.final",
          nodes: [
            { id: "job.origins", name: "Origins", status: "completed" },
            {
              id: "job.final",
              name: "Final synthesis",
              status: "running",
              responsibility: "merge",
            },
          ],
        },
      },
    });
  };

  const result = await pollChatJob(
    "job-1",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.output, "Done.");
  assert.equal(result.progress.total, 2);
  assert.equal(result.progress.completed, 1);
  assert.equal(result.progress.merging, true);
});

test("cleans worker metadata and repeated role-prefixed output", () => {
  const output = cleanChatOutput(
    "llama.cpp mode=cuda; model=Qwen/Qwen2.5-1.5B-Instruct; path=C:\\Users\\batal\\.opengpu\\models\\qwen.gguf; max_tokens=512; response=system: The President of the United States is Donald Trump. He is the 47th President of the United States. He is the 47th President of the United States. He is the 47th President of the United States.",
  );

  assert.equal(
    output,
    "The President of the United States is Donald Trump. He is the 47th President of the United States.",
  );
  assert.doesNotMatch(output, /llama\.cpp|path=|response=|system:/i);
});

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("cleans embedded role leakage and repeated answer spam", () => {
  const output = cleanChatOutput(
    "So what is the point of this article? system: The article is about election coverage. The article is about election coverage. The article is written in a balanced way.",
  );

  assert.equal(
    output,
    "The article is about election coverage. The article is written in a balanced way.",
  );
  assert.doesNotMatch(output, /system:|So what is the point/i);
});

test("returns a user-facing fallback for empty cleaned responses", () => {
  assert.equal(
    cleanChatOutput("llama.cpp mode=cuda; response=system:"),
    "MundusX returned an empty response. Please try again.",
  );
});
