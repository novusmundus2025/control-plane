import test from "node:test";
import assert from "node:assert/strict";

import { PostgresAuthStore, authConfigFromEnv } from "../src/auth.js";

test("browser authentication is required by default and uses the pooled database URL", () => {
  const config = authConfigFromEnv({
    MUNDUSX_DATABASE_POOL_URL: "postgresql://pool.example/mundusx",
    DATABASE_URL: "postgresql://direct.example/mundusx",
  });
  assert.equal(config.required, true);
  assert.equal(config.databaseUrl, "postgresql://pool.example/mundusx");
});

test("login providers remain disabled until both halves of their configuration exist", () => {
  const store = new PostgresAuthStore({
    githubClientId: "client",
    githubClientSecret: "",
    resendApiKey: "key",
    emailFrom: "",
  }, { pool: {} });
  assert.deepEqual(store.providers(), { github: false, email: false });
});

test("conversation ownership is claimed once and rejects another user", async () => {
  const rows = new Map();
  const pool = {
    async query(sql, values) {
      if (sql.startsWith("insert into")) {
        if (!rows.has(values[0])) rows.set(values[0], values[1]);
        return { rowCount: 1, rows: [] };
      }
      const matches = rows.get(values[0]) === values[1];
      return { rowCount: matches ? 1 : 0, rows: matches ? [{ exists: 1 }] : [] };
    },
  };
  const store = new PostgresAuthStore({}, { pool });
  const conversation = "d0c1f854-60e7-4af3-95fe-2745621de39d";
  await store.authorizeConversation("user-a", conversation, true);
  await assert.rejects(
    store.authorizeConversation("user-b", conversation, true),
    (error) => error.statusCode === 404,
  );
});
