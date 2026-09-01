import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderSkillsPage } from "../src/features/skills/page.js";
import { createSkillRegistry, validateSkillDraft } from "../src/features/skills/registry.js";

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../skills");

test("skill registry loads app-owned Markdown with stable metadata", () => {
  const registry = createSkillRegistry({ skillsDir });
  const catalog = registry.catalog();

  assert.equal(registry.version, 1);
  assert.equal(catalog.length, 10);
  assert.equal(catalog.find((skill) => skill.id === "verifier")?.enabled, false);
  assert.match(registry.content("router"), /^# Router Skill/);
  assert.equal(registry.content("verifier"), null);
  assert.equal(registry.content("missing", "fallback"), "fallback");
  assert.equal(Object.hasOwn(catalog[0], "content"), false);
  assert.equal(Object.hasOwn(catalog[0], "prompt_lines"), false);
});

test("skill draft validation bounds prompt lines and rejects secrets", () => {
  const longDraft = ["# Example", "", "Purpose: safe behavior", ...Array.from({ length: 13 }, (_, index) => `- Rule ${index + 1}`)].join("\n");
  const valid = validateSkillDraft(longDraft);
  assert.equal(valid.valid, true);
  assert.equal(valid.promptLines.length, 12);
  assert.match(valid.warnings.join(" "), /first 12 meaningful instruction lines/);

  const unsafe = validateSkillDraft("# Unsafe\n\napi_key=secret-value");
  assert.equal(unsafe.valid, false);
  assert.match(unsafe.errors.join(" "), /credentials or private keys/);
});

test("no-auth Skills page keeps drafts local and exposes no private instructions", () => {
  const registry = createSkillRegistry({ skillsDir });
  const html = renderSkillsPage({ catalog: registry.catalog(), version: registry.version });

  assert.match(html, /Runtime skills/);
  assert.match(html, /Publishing is intentionally unavailable/);
  assert.match(html, /localStorage\.setItem/);
  assert.match(html, /apps\/chat\/skills\//);
  assert.doesNotMatch(html, /Do not use regex\/API extraction to guess compound prompt chunks/);
  assert.doesNotMatch(html, /fetch\(['"]\/api\/skills|method:\s*['"]POST/);
  assert.match(html, /split\(\/\\r\?\\n\/\)/);
  assert.doesNotMatch(html, /[\b\r]/);
});
