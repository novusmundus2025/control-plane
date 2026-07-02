import test from "node:test";
import assert from "node:assert/strict";

import { cleanChatOutput, configFromEnv, escapeHtml, page } from "../src/main.js";

test("renders a usable chat page", () => {
  const html = page(
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai/",
      MUNDUSX_CHAT_DEFAULT_MODEL: "Qwen/Test",
      MUNDUSX_CHAT_TIMEOUT_SECONDS: "45",
    }),
  );

  assert.match(html, /MundusX Chat/);
  assert.match(html, /Welcome to MundusX Chat/);
  assert.match(html, /id="chat-form"/);
  assert.match(html, /Message MundusX/);
  assert.match(html, /\[ \/ \] Commands/);
  assert.match(html, /\/assets\/mundusx-logo\.png/);
  assert.match(html, /uat\.mundusx\.ai/);
  assert.match(html, /Qwen\/Test/);
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
});

test("escapes runtime values rendered into html", () => {
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
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

test("returns a user-facing fallback for empty cleaned responses", () => {
  assert.equal(
    cleanChatOutput("llama.cpp mode=cuda; response=system:"),
    "MundusX returned an empty response. Please try again.",
  );
});
