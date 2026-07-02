import test from "node:test";
import assert from "node:assert/strict";

import { configFromEnv, escapeHtml, page } from "../src/main.js";

test("renders a usable chat page", () => {
  const html = page(
    configFromEnv({
      MUNDUSX_CONTROL_PLANE_URL: "https://uat.mundusx.ai/",
      MUNDUSX_CHAT_DEFAULT_MODEL: "Qwen/Test",
      MUNDUSX_CHAT_TIMEOUT_SECONDS: "45",
    }),
  );

  assert.match(html, /MundusX Chat/);
  assert.match(html, /id="chat-form"/);
  assert.match(html, /Message MundusX/);
  assert.match(html, /\/assets\/mundusx-logo\.png/);
  assert.match(html, /https:\/\/uat\.mundusx\.ai/);
  assert.match(html, /Qwen\/Test/);
  assert.match(html, /Default timeout: 45s/);
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
