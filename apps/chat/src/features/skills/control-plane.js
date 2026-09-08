import { timingSafeEqual } from "node:crypto";
import { validateSkillDraft } from "./registry.js";
import { httpError } from "../../shared/http-error.js";

// Server-to-server only. The control plane validates the administrator session
// and Origin before forwarding writes; its credential never reaches the browser.
export function createGlobalSkillsController({ authStore, registry, token, readJsonBody, sendJson }) {
  return async ({ request, response, url }) => {
    if (url.pathname !== "/internal/control-plane/skills") return false;
    const expected = Buffer.from(String(token || ""));
    const supplied = Buffer.from(String(request.headers.authorization || "").replace(/^Bearer /, ""));
    if (expected.length < 32 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw httpError(401, "Control-plane authentication required");
    }
    if (request.method === "GET") {
      const overrides = new Map((await authStore.globalSkillOverrides()).map(x => [x.skill_id, x]));
      const system = registry.catalog().map(entry => {
        const override = overrides.get(entry.id);
        return { ...entry, content: override?.content ?? registry.rawContent(entry.id),
          enabled: override?.enabled ?? entry.enabled, version: override?.version ?? 1 };
      });
      sendJson(response, 200, { system });
      return true;
    }
    if (request.method === "PUT") {
      const input = await readJsonBody(request);
      if (!registry.has(input?.id)) throw httpError(404, "Global skill not found");
      const content = String(input.content || "").trim();
      const validation = validateSkillDraft(content);
      if (!validation.valid) throw httpError(400, validation.errors.join("; "));
      const saved = await authStore.saveControlPlaneGlobalSkill(input.actor, input.id, { content, enabled: input.enabled !== false });
      sendJson(response, 200, saved);
      return true;
    }
    throw httpError(405, "Method not allowed");
  };
}
