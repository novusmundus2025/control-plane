import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanChatOutput,
  configFromEnv,
  escapeHtml,
  extractWeatherLocation,
  fetchNetworkSummary,
  page,
  pollChatJob,
  submitChatJob,
  submitChatTurn,
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
  assert.match(html, /\.work-trace/);
  assert.match(html, /Source chunks/);
  assert.match(html, /Message MundusX/);
  assert.match(html, /\[ \/ \] Commands/);
  assert.match(html, /\.message\.assistant \.message-body/);
  assert.match(html, /\.message\.user \.message-body/);
  assert.match(html, /aria-label", role === "user" \? "Your message" : "MundusX response"/);
  assert.doesNotMatch(html, /avatar\.textContent = role === "user" \? "You" : "M"/);
  assert.match(html, /\/assets\/mundusx-logo\.png/);
  assert.match(html, /uat\.mundusx\.ai/);
  assert.match(html, /\.header-actions \{\s*display: none;/);
  assert.match(html, /class="runtime-status-sentinel" id="runtime-status"/);
  assert.match(html, /\.history-item span:first-child/);
  assert.doesNotMatch(html, /class="account-card"/);
  assert.doesNotMatch(html, /class="model-pill">Control-plane routed/);
  assert.doesNotMatch(html, /<button class="settings-button"/);
  assert.doesNotMatch(html, /<div class="status"><span class="dot"><\/span><span id="runtime-status">Ready<\/span><\/div>/);
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

test("routes weather questions to wttr without queuing an LLM job", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    assert.equal(url, "https://wttr.in/Manila?format=j1");
    return jsonResponse({
      nearest_area: [
        {
          areaName: [{ value: "Manila" }],
          region: [{ value: "National Capital Region" }],
          country: [{ value: "Philippines" }],
        },
      ],
      current_condition: [
        {
          weatherDesc: [{ value: "Partly cloudy" }],
          temp_C: "31",
          temp_F: "88",
          FeelsLikeC: "36",
          FeelsLikeF: "97",
          humidity: "70",
          windspeedKmph: "12",
          localObsDateTime: "2026-07-03 05:00 PM",
        },
      ],
    });
  };

  const result = await submitChatJob(
    { message: "what is the weather in Manila today?" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(calls.length, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.model, "wttr.in");
  assert.equal(result.execution_mode, "tool");
  assert.equal(result.tool, "weather");
  assert.equal(result.assigned_node_id, "weather-tool");
  assert.match(result.output, /Weather for Manila, National Capital Region, Philippines/);
  assert.match(result.output, /Partly cloudy, 31C\/88F/);
});

test("returns immediate weather turns without polling the control plane", async () => {
  const result = await submitChatTurn(
    { message: "forecast for Cebu" },
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    async (url) => {
      assert.equal(url, "https://wttr.in/Cebu?format=j1");
      return jsonResponse({
        nearest_area: [{ areaName: [{ value: "Cebu" }], country: [{ value: "Philippines" }] }],
        current_condition: [
          {
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "30",
            temp_F: "86",
            FeelsLikeC: "34",
            FeelsLikeF: "93",
            humidity: "65",
            windspeedKmph: "9",
          },
        ],
      });
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.progress.strategy, "weather_tool");
});

test("extracts only obvious weather locations", () => {
  assert.equal(extractWeatherLocation("weather in Warsaw please"), "Warsaw");
  assert.equal(extractWeatherLocation("temperature for New York right now"), "New York");
  assert.equal(extractWeatherLocation("Give me a history of Honda"), null);
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
              output: "llama.cpp mode=cuda; response=assistant: Final notes.",
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
  assert.equal(result.progress.nodes[1].output, "");
});

test("returns compact completed chunk outputs for decomposed jobs", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      job: {
        job_id: "job-2",
        status: "assigned",
        execution_mode: "decompose",
        graph_execution_enabled: true,
        graph: {
          nodes: [
            {
              id: "job.origins",
              name: "Origins",
              status: "completed",
              assigned_node_id: "node-1",
              latency_ms: 18000,
              queue_wait_ms: 500,
              output_chars: 48,
              estimated_output_tokens: 12,
              effective_max_tokens: 256,
              output: "llama.cpp mode=cuda; response=assistant: Founded in 1916. Founded in 1916.",
            },
            { id: "job.modern", name: "Modern era", status: "running" },
            {
              id: "job.notes",
              name: "Compile and usage notes",
              status: "completed",
              output: "Do not include any implementation details. Do not include any source code. Do not include examples.",
            },
          ],
        },
      },
    });

  const result = await pollChatJob(
    "job-2",
    configFromEnv({ MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai" }),
    fetchImpl,
  );

  assert.equal(result.progress.nodes[0].output, "Founded in 1916.");
  assert.equal(result.progress.nodes[0].assigned_node_id, "node-1");
  assert.equal(result.progress.nodes[0].latency_ms, 18000);
  assert.equal(result.progress.nodes[0].queue_wait_ms, 500);
  assert.equal(result.progress.nodes[0].output_chars, 48);
  assert.equal(result.progress.nodes[0].estimated_output_tokens, 12);
  assert.equal(result.progress.nodes[0].effective_max_tokens, 256);
  assert.equal(result.progress.nodes[1].output, "");
  assert.equal(result.progress.nodes[2].output, "");
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

test("removes leaked subjob instructions while keeping chunk content", () => {
  const output = cleanChatOutput(
    "Do not include any external links or references. Do not generate any output that is not factual and directly related to the user's request. MundusX subjob: Name: History Responsibility: section Required output: Explain the history of Mercedes-Benz from its origins to today. Write the factual content for this section only, in plain prose or compact bullets. Origins and founders: Mercedes-Benz was founded in 1926 by Gottlieb Daimler and Wilhelm Maybach.",
  );

  assert.equal(
    output,
    "Origins and founders: Mercedes-Benz was founded in 1926 by Gottlieb Daimler and Wilhelm Maybach.",
  );
  assert.doesNotMatch(output, /Do not include|Required output|MundusX subjob|Write the factual/i);
});

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
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
