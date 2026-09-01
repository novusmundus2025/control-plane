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

test("GitHub access remains disabled until credentials and encryption exist", () => {
  const store = new PostgresAuthStore({
    githubClientId: "client",
    githubClientSecret: "",
    resendApiKey: "key",
    emailFrom: "",
  }, { pool: {} });
  assert.deepEqual(store.providers(), { github: false, email: false });
});

test("GitHub provider requires a valid 32-byte encryption key", () => {
  const config = authConfigFromEnv({
    MUNDUSX_GITHUB_CLIENT_ID: "client",
    MUNDUSX_GITHUB_CLIENT_SECRET: "secret",
    MUNDUSX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  assert.equal(new PostgresAuthStore(config, { pool: {} }).providers().github, true);
});

test("repository normalization preserves live pull and push permissions", () => {
  const store = new PostgresAuthStore({}, { pool: {} });
  assert.deepEqual(store.normalizeRepository({
    id: 42,
    full_name: "owner/repo",
    private: true,
    default_branch: "trunk",
    permissions: { pull: true, push: false, admin: false },
  }), {
    id: 42,
    installation_id: null,
    full_name: "owner/repo",
    private: true,
    default_branch: "trunk",
    permissions: { pull: true, push: false, admin: false },
  });
});

test("new Java repositories are private user-owned projects with bounded Maven policy", async () => {
  let githubRequest;
  let policyInsert;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) { policyInsert = { sql, values }; return { rows: [] }; },
  } });
  store.githubJson = async (_userId, url, options) => {
    githubRequest = { url, options };
    return {
      id: 84,
      full_name: "alice/my-java-program",
      private: true,
      default_branch: "main",
      owner: { login: "alice" },
      permissions: { pull: true, push: true, admin: true },
    };
  };

  const result = await store.createRepository("user-alice", {
    name: "my-java-program",
    description: "A tested Java project",
    template: "java-maven",
  });

  assert.equal(githubRequest.url, "https://api.github.com/user/repos");
  assert.equal(githubRequest.options.method, "POST");
  assert.deepEqual(githubRequest.options.body, {
    name: "my-java-program",
    description: "A tested Java project",
    private: true,
    auto_init: true,
  });
  assert.equal(result.repository.full_name, "alice/my-java-program");
  assert.equal(policyInsert.values[1], "alice/my-java-program");
  assert.equal(policyInsert.values[2], "user:user-alice");
  assert.deepEqual(policyInsert.values[3], ["src", "pom.xml", "README.md", ".gitignore"]);
  assert.deepEqual(policyInsert.values[4], ["java-maven-test"]);
  assert.deepEqual(policyInsert.values[5], ["hybrid"]);
});

test("repository creation rejects invalid names before calling GitHub", async () => {
  const store = new PostgresAuthStore({}, { pool: {} });
  store.githubJson = async () => assert.fail("GitHub must not be called");
  await assert.rejects(
    store.createRepository("user-1", { name: "owner/repository" }),
    (error) => error.statusCode === 400,
  );
});

test("repository browser masks obvious embedded credentials and blocks secret files", async () => {
  const store = new PostgresAuthStore({}, { pool: {} });
  store.authorizeRepository = async () => ({ id: 42, full_name: "owner/repo", default_branch: "main", permissions: { pull: true, push: false, admin: false } });
  store.githubJson = async () => ({
    type: "file",
    encoding: "base64",
    name: "config.js",
    path: "src/config.js",
    size: 44,
    sha: "b".repeat(40),
    content: Buffer.from('const apiKey = "secret-value";').toString("base64"),
  });
  const result = await store.repositoryContents("user-1", "42", "src/config.js");
  assert.equal(result.file.redacted, true);
  assert.doesNotMatch(result.file.content, /secret-value/);
  await assert.rejects(
    store.repositoryContents("user-1", "42", ".env"),
    (error) => error.statusCode === 403,
  );
});

test("Harness authority intersects GitHub write rights with EHDA repository policy", async () => {
  const pool = { async query() { return { rows: [{
    repository_id: 42,
    repository_full_name: "owner/repo",
    tenant_id: "tenant-1",
    allowed_path_prefixes: ["src"],
    validation_profiles: ["tests"],
    allowed_execution_modes: ["sandbox"],
    require_write_permission: true,
  }] }; } };
  const store = new PostgresAuthStore({}, { pool });
  store.authorizeRepository = async () => ({ id: 42, full_name: "owner/repo", default_branch: "main", permissions: { pull: true, push: true, admin: false } });
  store.githubJson = async () => ({ sha: "a".repeat(40) });
  store.harnessRunners = async () => [{ ready: true, fresh: true }];
  const authority = await store.harnessAuthority("user-1", "42", "sandbox", ["patch.apply"]);
  assert.equal(authority.repository_source_id, "github:42:owner/repo");
  assert.equal(authority.base_revision, "a".repeat(40));
  assert.deepEqual(authority.allowed_path_prefixes, ["src"]);
});

test("runner pairing stores only a one-time code digest", async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) { queries.push({ sql, values }); return { rows: [] }; },
    release() {},
  };
  const store = new PostgresAuthStore({}, { pool: { async connect() { return client; } } });
  const result = await store.createHarnessRunnerPairing("user-1");
  assert.match(result.pairing_code, /^MX-[A-Za-z0-9_-]{32}$/);
  const insert = queries.find((query) => query.sql.includes("insert into public.harness_runner_pairings"));
  assert.equal(insert.values[0].length, 64);
  assert.notEqual(insert.values[0], result.pairing_code);
  assert.equal(result.expires_in_seconds, 600);
});

test("runner inventory exposes only bounded lowercase local project slugs", async () => {
  const store = new PostgresAuthStore({}, { pool: {
    async query() {
      return { rows: [{
        runner_id: "runner-1",
        device_id: "device-1",
        execution_modes: ["hybrid"],
        supported_operations: ["file.read"],
        local_projects: ["alpha", "my-java-program", "../another-user", "Bad Name"],
        parallel_slots: 1,
        ready: true,
        trusted_identity: true,
        last_seen_epoch: Math.floor(Date.now() / 1000),
      }] };
    },
  } });
  const [runner] = await store.harnessRunners("user-1");
  assert.deepEqual(runner.local_projects, ["alpha", "my-java-program"]);
  assert.equal(runner.fresh, true);
});

test("Harness authority rejects repositories without an active EHDA policy", async () => {
  const store = new PostgresAuthStore({}, { pool: { async query() { return { rows: [] }; } } });
  store.authorizeRepository = async () => ({ id: 42, full_name: "owner/repo", default_branch: "main", permissions: { pull: true, push: true, admin: false } });
  store.githubJson = async () => [];
  await assert.rejects(
    store.harnessAuthority("user-1", "42", "sandbox", ["repository.status"]),
    (error) => error.statusCode === 403,
  );
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

test("MCP credentials are returned once and stored only as a digest", async () => {
  let insert;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) {
      insert = { sql, values };
      return { rows: [{ token_id: "11111111-1111-4111-8111-111111111111", name: values[2] }] };
    },
  } });

  const created = await store.createMcpToken("user-1", { name: "My Codex", expires_in_days: 30 });
  assert.match(created.token, /^mxmcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(insert.values[1].length, 64);
  assert.notEqual(insert.values[1], created.token);
  assert.equal(insert.values[2], "My Codex");
  assert.equal(insert.values[3], 30);
});

test("MCP bearer authentication resolves only an active token owner", async () => {
  const queries = [];
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes("from public.mcp_personal_access_tokens")) {
        return { rows: [{ token_id: "token-id", id: "user-1", email: "user@example.com", role: "operator" }] };
      }
      return { rows: [] };
    },
  } });

  const session = await store.mcpSession({ headers: { authorization: `Bearer mxmcp_${"a".repeat(43)}` } });
  assert.equal(session.id, "user-1");
  assert.equal(queries[0].values[0].length, 64);
  assert.equal(await store.mcpSession({ headers: { authorization: "Bearer invalid" } }), null);
});

test("MCP token revocation is scoped to the authenticated owner", async () => {
  let update;
  const store = new PostgresAuthStore({}, { pool: {
    async query(sql, values) { update = { sql, values }; return { rowCount: 1, rows: [{ token_id: values[0] }] }; },
  } });
  const tokenId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(await store.revokeMcpToken("user-1", tokenId), { revoked: true, token_id: tokenId });
  assert.deepEqual(update.values, [tokenId, "user-1"]);
  assert.match(update.sql, /user_id = \$2::uuid/);
});
