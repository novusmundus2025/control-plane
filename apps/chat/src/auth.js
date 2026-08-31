import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";

const SESSION_COOKIE = "__Host-mx_session";
const CSRF_COOKIE = "__Host-mx_csrf";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 10 * 60;
const RUNNER_PAIRING_SECONDS = 10 * 60;
const GITHUB_API_VERSION = "2026-03-10";
const MAX_GITHUB_PAGES = 5;
const MAX_GITHUB_INSTALLATIONS = 20;
const MAX_GITHUB_REPOSITORIES = 1000;
const MAX_REPOSITORY_FILE_BYTES = 256 * 1024;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? [part, ""] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
  }));
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  return email;
}

function safeRedirect(value) {
  const path = String(value || "/");
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

function cookie(name, value, maxAge, httpOnly = true) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}`;
}

function encryptionKey(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch { return null; }
}

function encryptSecret(value, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value, key) {
  const [nonce, tag, encrypted] = String(value).split(".").map((part) => Buffer.from(part, "base64url"));
  if (!nonce || nonce.length !== 12 || !tag || tag.length !== 16 || !encrypted) throw new Error("Encrypted GitHub credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function githubHeaders(accessToken) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "X-GitHub-Api-Version": GITHUB_API_VERSION };
}

function sensitiveRepositoryPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
  return normalized.split("/").some((part) => part === ".git" || part === ".env" || part.startsWith(".env.") || /^(id_rsa|id_ed25519|.*\.(pem|p12|pfx|key))$/.test(part));
}

function redactRepositoryText(value) {
  let redacted = false;
  const content = String(value || "")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, () => {
      redacted = true;
      return "[REDACTED PRIVATE KEY]";
    })
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["']?)([^\s"',;]+)/gi, (_match, prefix) => {
      redacted = true;
      return `${prefix}[REDACTED]`;
    });
  return { content, redacted };
}

export function authConfigFromEnv(env = process.env) {
  return {
    required: !["0", "false", "no"].includes(String(env.MUNDUSX_CHAT_AUTH_REQUIRED ?? "true").toLowerCase()),
    databaseUrl: String(env.MUNDUSX_DATABASE_POOL_URL ?? env.DATABASE_URL ?? "").trim(),
    publicOrigin: String(env.MUNDUSX_PUBLIC_ORIGIN ?? "https://chat-u.mundusx.ai").replace(/\/$/, ""),
    githubClientId: String(env.MUNDUSX_GITHUB_CLIENT_ID ?? "").trim(),
    githubClientSecret: String(env.MUNDUSX_GITHUB_CLIENT_SECRET ?? "").trim(),
    encryptionKey: encryptionKey(String(env.MUNDUSX_AUTH_ENCRYPTION_KEY ?? "").trim()),
    resendApiKey: String(env.RESEND_API_KEY ?? "").trim(),
    emailFrom: String(env.MUNDUSX_AUTH_EMAIL_FROM ?? "").trim(),
  };
}

export class PostgresAuthStore {
  constructor(config, { fetchImpl = fetch, pool } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.pool = pool ?? (config.databaseUrl ? new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 }) : null);
  }

  ensureReady() {
    if (!this.pool) throw Object.assign(new Error("Authentication storage is unavailable"), { statusCode: 503 });
  }

  providers() {
    return {
      github: Boolean(this.config.githubClientId && this.config.githubClientSecret && this.config.encryptionKey),
      email: Boolean(this.config.resendApiKey && this.config.emailFrom),
    };
  }

  async session(request) {
    this.ensureReady();
    const raw = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const result = await this.pool.query(`
      select s.session_hash, s.csrf_hash, u.id, u.email, u.display_name, u.role,
        exists(select 1 from public.github_user_tokens gt where gt.user_id = u.id) as github_connected
      from public.user_sessions s
      join public.users u on u.id = s.user_id
      where s.session_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'
      group by s.session_hash, s.csrf_hash, u.id, u.email, u.display_name, u.role`, [digest(raw)]);
    return result.rows[0] ?? null;
  }

  requireCsrf(request, session) {
    const cookies = parseCookies(request.headers.cookie);
    const supplied = String(request.headers["x-mundusx-csrf"] || "");
    const origin = String(request.headers.origin || "");
    if (!origin || origin !== this.config.publicOrigin || !supplied || supplied !== cookies[CSRF_COOKIE] || digest(supplied) !== session.csrf_hash) {
      throw Object.assign(new Error("CSRF validation failed"), { statusCode: 403 });
    }
  }

  async createSession(response, userId, provider, database = this.pool) {
    const raw = token();
    const csrf = token();
    await database.query(`insert into public.user_sessions
      (session_hash, csrf_hash, user_id, provider, expires_at)
      values ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
      [digest(raw), digest(csrf), userId, provider, SESSION_SECONDS]);
    response.setHeader("Set-Cookie", [cookie(SESSION_COOKIE, raw, SESSION_SECONDS), cookie(CSRF_COOKIE, csrf, SESSION_SECONDS, false)]);
  }

  async logout(request, response, session) {
    this.requireCsrf(request, session);
    await this.pool.query("update public.user_sessions set revoked_at = now() where session_hash = $1", [session.session_hash]);
    response.setHeader("Set-Cookie", [cookie(SESSION_COOKIE, "", 0), cookie(CSRF_COOKIE, "", 0, false)]);
  }

  async authorizeConversation(userId, conversationId, create = false) {
    if (!conversationId) throw Object.assign(new Error("conversation id is required"), { statusCode: 400 });
    try {
      if (create) {
        await this.pool.query("insert into public.user_chat_conversations (conversation_id, user_id) values ($1::uuid, $2::uuid) on conflict (conversation_id) do nothing", [conversationId, userId]);
      }
      const found = await this.pool.query("select 1 from public.user_chat_conversations where conversation_id = $1::uuid and user_id = $2::uuid", [conversationId, userId]);
      if (found.rowCount !== 1) throw Object.assign(new Error("Conversation is not available to this user"), { statusCode: 404 });
    } catch (error) {
      if (error.code === "22P02") throw Object.assign(new Error("conversation id must be a UUID"), { statusCode: 400 });
      throw error;
    }
  }

  async storeGithubToken(database, userId, payload) {
    if (!this.config.encryptionKey) throw Object.assign(new Error("GitHub credential encryption is unavailable"), { statusCode: 503 });
    const accessExpiresAt = Number(payload.expires_in) > 0 ? new Date(Date.now() + Number(payload.expires_in) * 1000) : null;
    const refreshExpiresAt = Number(payload.refresh_token_expires_in) > 0 ? new Date(Date.now() + Number(payload.refresh_token_expires_in) * 1000) : null;
    await database.query(`insert into public.github_user_tokens
      (user_id, access_ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, token_type)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id) do update set
        access_ciphertext = excluded.access_ciphertext,
        refresh_ciphertext = coalesce(excluded.refresh_ciphertext, public.github_user_tokens.refresh_ciphertext),
        access_expires_at = excluded.access_expires_at,
        refresh_expires_at = coalesce(excluded.refresh_expires_at, public.github_user_tokens.refresh_expires_at),
        token_type = excluded.token_type,
        updated_at = now()`, [
      userId,
      encryptSecret(payload.access_token, this.config.encryptionKey),
      payload.refresh_token ? encryptSecret(payload.refresh_token, this.config.encryptionKey) : null,
      accessExpiresAt,
      refreshExpiresAt,
      String(payload.token_type || "bearer").toLowerCase(),
    ]);
  }

  async githubToken(userId) {
    this.ensureReady();
    if (!this.providers().github) throw Object.assign(new Error("GitHub App access is unavailable"), { statusCode: 503 });
    const result = await this.pool.query("select * from public.github_user_tokens where user_id = $1", [userId]);
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error("Connect GitHub to access repositories"), { statusCode: 403 });
    const expiresAt = row.access_expires_at ? new Date(row.access_expires_at).getTime() : null;
    if (!expiresAt || expiresAt > Date.now() + 5 * 60 * 1000) return decryptSecret(row.access_ciphertext, this.config.encryptionKey);
    if (!row.refresh_ciphertext || (row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() <= Date.now())) {
      await this.pool.query("delete from public.github_user_tokens where user_id = $1", [userId]);
      throw Object.assign(new Error("GitHub access expired; reconnect your account"), { statusCode: 401 });
    }
    const refreshed = await this.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        grant_type: "refresh_token",
        refresh_token: decryptSecret(row.refresh_ciphertext, this.config.encryptionKey),
      }),
    });
    const payload = await refreshed.json();
    if (!refreshed.ok || !payload.access_token) throw Object.assign(new Error("GitHub access could not be refreshed"), { statusCode: 502 });
    await this.storeGithubToken(this.pool, userId, payload);
    return payload.access_token;
  }

  async githubJson(userId, url) {
    const accessToken = await this.githubToken(userId);
    const response = await this.fetch(url, { headers: githubHeaders(accessToken) });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw Object.assign(new Error("GitHub access expired; reconnect your account"), { statusCode: 401 });
    if (response.status === 403) throw Object.assign(new Error("GitHub denied this repository operation"), { statusCode: 403 });
    if (response.status === 404) throw Object.assign(new Error("Repository resource was not found"), { statusCode: 404 });
    if (!response.ok) throw Object.assign(new Error(`GitHub returned ${response.status}`), { statusCode: 502 });
    return payload;
  }

  async repositories(userId) {
    const installations = [];
    for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
      const payload = await this.githubJson(userId, `https://api.github.com/user/installations?per_page=100&page=${page}`);
      const batch = Array.isArray(payload.installations) ? payload.installations : [];
      installations.push(...batch);
      if (batch.length < 100) break;
    }
    const repositories = [];
    for (const installation of installations.slice(0, MAX_GITHUB_INSTALLATIONS)) {
      for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
        const payload = await this.githubJson(userId, `https://api.github.com/user/installations/${encodeURIComponent(installation.id)}/repositories?per_page=100&page=${page}`);
        const batch = Array.isArray(payload.repositories) ? payload.repositories : [];
        repositories.push(...batch.map((repo) => this.normalizeRepository(repo, installation.id)));
        if (repositories.length >= MAX_GITHUB_REPOSITORIES) return repositories.slice(0, MAX_GITHUB_REPOSITORIES).sort((left, right) => left.full_name.localeCompare(right.full_name));
        if (batch.length < 100) break;
      }
    }
    return repositories.sort((left, right) => left.full_name.localeCompare(right.full_name));
  }

  normalizeRepository(repo, installationId = null) {
    return {
      id: Number(repo.id),
      installation_id: installationId,
      full_name: String(repo.full_name || ""),
      private: Boolean(repo.private),
      default_branch: String(repo.default_branch || "main"),
      permissions: {
        pull: Boolean(repo.permissions?.pull || repo.permissions?.triage || repo.permissions?.push || repo.permissions?.maintain || repo.permissions?.admin),
        push: Boolean(repo.permissions?.push || repo.permissions?.maintain || repo.permissions?.admin),
        admin: Boolean(repo.permissions?.admin),
      },
    };
  }

  async authorizeRepository(userId, repositoryId, { requirePush = false } = {}) {
    if (!/^\d+$/.test(String(repositoryId || ""))) throw Object.assign(new Error("repository id is invalid"), { statusCode: 400 });
    const repo = this.normalizeRepository(await this.githubJson(userId, `https://api.github.com/repositories/${repositoryId}`));
    if (!repo.id || !repo.full_name || !repo.permissions.pull || (requirePush && !repo.permissions.push)) {
      throw Object.assign(new Error(requirePush ? "Write access to this repository is required" : "Repository access is required"), { statusCode: 403 });
    }
    return repo;
  }

  async repositoryContents(userId, repositoryId, path = "", ref = "") {
    const repo = await this.authorizeRepository(userId, repositoryId);
    const normalizedPath = String(path || "").replace(/^\/+|\/+$/g, "");
    if (normalizedPath.includes("..") || sensitiveRepositoryPath(normalizedPath)) throw Object.assign(new Error("Repository path is not available"), { statusCode: 403 });
    const selectedRef = String(ref || repo.default_branch);
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(selectedRef) || selectedRef.includes("..")) throw Object.assign(new Error("repository ref is invalid"), { statusCode: 400 });
    const encodedPath = normalizedPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const payload = await this.githubJson(userId, `https://api.github.com/repos/${repo.full_name}/contents/${encodedPath}?ref=${encodeURIComponent(selectedRef)}`);
    if (Array.isArray(payload)) {
      return { repository: repo, ref: selectedRef, path: normalizedPath, entries: payload.slice(0, 500).filter((entry) => !sensitiveRepositoryPath(entry.path)).map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, size: entry.size, sha: entry.sha })) };
    }
    if (payload.type !== "file" || payload.encoding !== "base64" || Number(payload.size) > MAX_REPOSITORY_FILE_BYTES) throw Object.assign(new Error("Only bounded text files can be viewed"), { statusCode: 413 });
    const content = Buffer.from(String(payload.content || "").replace(/\s/g, ""), "base64").toString("utf8");
    if (content.includes("\0")) throw Object.assign(new Error("Binary files cannot be viewed"), { statusCode: 415 });
    const safeText = redactRepositoryText(content);
    return { repository: repo, ref: selectedRef, path: normalizedPath, file: { name: payload.name, path: payload.path, size: payload.size, sha: payload.sha, ...safeText } };
  }

  async harnessAuthority(userId, repositoryId, executionMode, operations = []) {
    if (!Array.isArray(operations)) throw Object.assign(new Error("allowed operations must be a list"), { statusCode: 400 });
    const requirePush = operations.some((operation) => ["patch.apply", "validation.run"].includes(String(operation)));
    const repo = await this.authorizeRepository(userId, repositoryId, { requirePush });
    let policyResult = await this.pool.query(`select * from public.repository_harness_policies
      where repository_id = $1 and status = 'active'`, [repo.id]);
    if (!policyResult.rows[0]) {
      const root = await this.githubJson(userId, `https://api.github.com/repos/${repo.full_name}/contents/?ref=${encodeURIComponent(repo.default_branch)}`);
      const allowedPathPrefixes = Array.isArray(root)
        ? root.filter((entry) => ["dir", "file"].includes(entry.type) && !sensitiveRepositoryPath(entry.path)).slice(0, 200).map((entry) => entry.path)
        : [];
      if (!allowedPathPrefixes.length) throw Object.assign(new Error("Repository has no safe paths available for Harness work"), { statusCode: 403 });
      await this.pool.query(`insert into public.repository_harness_policies
        (repository_id, repository_full_name, tenant_id, allowed_path_prefixes,
         validation_profiles, allowed_execution_modes, require_write_permission, created_by)
        values ($1, $2, $3, $4, $5, $6, true, $7)
        on conflict (repository_id) do nothing`, [
        repo.id,
        repo.full_name,
        `user:${userId}`,
        allowedPathPrefixes,
        ["repository-default"],
        ["sandbox", "hybrid"],
        `chat-user:${userId}`,
      ]);
      policyResult = await this.pool.query(`select * from public.repository_harness_policies
        where repository_id = $1 and status = 'active'`, [repo.id]);
    }
    const policy = policyResult.rows[0];
    if (!policy || policy.repository_full_name.toLowerCase() !== repo.full_name.toLowerCase()) throw Object.assign(new Error("This repository is not enabled for EHDA Harness work"), { statusCode: 403 });
    if (!policy.allowed_execution_modes.includes(executionMode)) throw Object.assign(new Error("EHDA policy does not permit this execution mode"), { statusCode: 403 });
    if (policy.require_write_permission && !repo.permissions.push) throw Object.assign(new Error("Write permission is required by EHDA policy"), { statusCode: 403 });
    const commit = await this.githubJson(userId, `https://api.github.com/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`);
    if (!/^[0-9a-f]{40}$/i.test(String(commit.sha || ""))) throw Object.assign(new Error("GitHub did not return an immutable base revision"), { statusCode: 502 });
    const authority = {
      user_id: userId,
      tenant_id: policy.tenant_id,
      repository_source_id: `github:${repo.id}:${repo.full_name}`,
      base_revision: String(commit.sha).toLowerCase(),
      allowed_path_prefixes: policy.allowed_path_prefixes,
      validation_profiles: policy.validation_profiles,
      allowed_execution_modes: policy.allowed_execution_modes,
    };
    const runners = await this.harnessRunners(userId);
    if (!runners.some((runner) => runner.ready && runner.fresh)) {
      throw Object.assign(new Error("Pair and start your Harness runner before submitting repository work"), { statusCode: 409 });
    }
    return authority;
  }

  async createHarnessRunnerPairing(userId) {
    this.ensureReady();
    const pairingCode = `MX-${token(24)}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "delete from public.harness_runner_pairings where user_id = $1 and consumed_at is null",
        [userId],
      );
      await client.query(`insert into public.harness_runner_pairings
        (pairing_hash, user_id, expires_at)
        values ($1, $2, now() + ($3 * interval '1 second'))`,
        [digest(pairingCode), userId, RUNNER_PAIRING_SECONDS],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      pairing_code: pairingCode,
      expires_in_seconds: RUNNER_PAIRING_SECONDS,
    };
  }

  async harnessRunners(userId) {
    this.ensureReady();
    const result = await this.pool.query(`select runner_id, device_id, execution_modes,
      supported_operations, parallel_slots, ready, trusted_identity, last_seen_epoch
      from public.harness_runners
      where owner_user_id = $1
      order by last_seen_epoch desc
      limit 20`, [userId]);
    const nowEpoch = Math.floor(Date.now() / 1000);
    return result.rows.map((runner) => ({
      runner_id: runner.runner_id,
      device_id: runner.device_id,
      execution_modes: Array.isArray(runner.execution_modes) ? runner.execution_modes : [],
      supported_operations: Array.isArray(runner.supported_operations) ? runner.supported_operations : [],
      parallel_slots: Number(runner.parallel_slots),
      ready: Boolean(runner.ready),
      trusted_identity: Boolean(runner.trusted_identity),
      last_seen_epoch: Number(runner.last_seen_epoch),
      fresh: nowEpoch - Number(runner.last_seen_epoch) <= 60,
    }));
  }

  async startGithub(redirectPath = "/") {
    this.ensureReady();
    if (!this.providers().github) throw Object.assign(new Error("GitHub login is unavailable"), { statusCode: 503 });
    const state = token();
    const verifier = token(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await this.pool.query(`insert into public.auth_challenges
      (challenge_hash, challenge_type, code_verifier, redirect_path, expires_at)
      values ($1, 'github_oauth', $2, $3, now() + ($4 * interval '1 second'))`,
      [digest(state), verifier, safeRedirect(redirectPath), CHALLENGE_SECONDS]);
    const params = new URLSearchParams({ client_id: this.config.githubClientId, redirect_uri: `${this.config.publicOrigin}/api/auth/github/callback`, scope: "read:user user:email", state, code_challenge: challenge, code_challenge_method: "S256" });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async finishGithub(query, response) {
    this.ensureReady();
    const state = String(query.get("state") || "");
    const code = String(query.get("code") || "");
    const found = await this.pool.query(`update public.auth_challenges set consumed_at = now()
      where challenge_hash = $1 and challenge_type = 'github_oauth' and consumed_at is null and expires_at > now()
      returning code_verifier, redirect_path`, [digest(state)]);
    if (!code || found.rowCount !== 1) throw Object.assign(new Error("Invalid or expired GitHub login"), { statusCode: 400 });
    const exchange = await this.fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: this.config.githubClientId, client_secret: this.config.githubClientSecret, code, redirect_uri: `${this.config.publicOrigin}/api/auth/github/callback`, code_verifier: found.rows[0].code_verifier }) });
    const exchanged = await exchange.json();
    if (!exchange.ok || !exchanged.access_token) throw Object.assign(new Error("GitHub login verification failed"), { statusCode: 502 });
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${exchanged.access_token}`, "X-GitHub-Api-Version": "2022-11-28" };
    const [profileResponse, emailsResponse] = await Promise.all([this.fetch("https://api.github.com/user", { headers }), this.fetch("https://api.github.com/user/emails", { headers })]);
    const profile = await profileResponse.json();
    const emails = await emailsResponse.json();
    const verified = Array.isArray(emails) ? (emails.find((item) => item.verified && item.primary) ?? emails.find((item) => item.verified)) : null;
    const email = normalizeEmail(verified?.email);
    if (!profileResponse.ok || !emailsResponse.ok || !profile?.id || !email) throw Object.assign(new Error("GitHub account needs a verified email"), { statusCode: 403 });
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const userId = await this.upsertIdentity(client, { provider: "github", subject: String(profile.id), login: profile.login, email, displayName: profile.name || profile.login, profile: { avatar_url: profile.avatar_url } });
      await this.storeGithubToken(client, userId, exchanged);
      await client.query("commit");
      await this.createSession(response, userId, "github", client);
      return safeRedirect(found.rows[0].redirect_path);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async upsertIdentity(client, identity) {
    const existing = await client.query("select user_id from public.user_identities where provider = $1 and provider_subject = $2", [identity.provider, identity.subject]);
    let userId = existing.rows[0]?.user_id;
    if (!userId) {
      const user = await client.query(`insert into public.users (email, display_name, role, last_login_at)
        values ($1, $2, 'user', now()) on conflict (email) do update set display_name = coalesce(excluded.display_name, public.users.display_name), last_login_at = now(), updated_at = now() returning id`, [identity.email, identity.displayName]);
      userId = user.rows[0].id;
      await client.query(`insert into public.user_identities
        (user_id, provider, provider_subject, provider_login, email, email_verified, profile_json)
        values ($1, $2, $3, $4, $5, true, $6)`, [userId, identity.provider, identity.subject, identity.login || null, identity.email, identity.profile || {}]);
    } else {
      await client.query("update public.users set last_login_at = now(), updated_at = now() where id = $1", [userId]);
    }
    return userId;
  }

  async startEmail(emailInput) {
    this.ensureReady();
    if (!this.providers().email) throw Object.assign(new Error("Email login is unavailable"), { statusCode: 503 });
    const email = normalizeEmail(emailInput);
    if (!email) throw Object.assign(new Error("Enter a valid email address"), { statusCode: 400 });
    const recent = await this.pool.query("select count(*)::int as count from public.auth_challenges where lower(email) = $1 and created_at > now() - interval '15 minutes'", [email]);
    if (recent.rows[0].count >= 5) throw Object.assign(new Error("Too many login requests; try later"), { statusCode: 429 });
    const raw = token();
    await this.pool.query(`insert into public.auth_challenges
      (challenge_hash, challenge_type, email, expires_at) values ($1, 'email_magic_link', $2, now() + interval '15 minutes')`, [digest(raw), email]);
    const link = `${this.config.publicOrigin}/api/auth/email/verify?token=${encodeURIComponent(raw)}`;
    const sent = await this.fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${this.config.resendApiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: this.config.emailFrom, to: [email], subject: "Sign in to MundusX", html: `<p>Use this single-use link to sign in:</p><p><a href="${link}">Sign in to MundusX</a></p><p>This link expires in 15 minutes.</p>` }) });
    if (!sent.ok) throw Object.assign(new Error("Login email could not be sent"), { statusCode: 502 });
  }

  async finishEmail(raw, response) {
    this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(`update public.auth_challenges set consumed_at = now()
        where challenge_hash = $1 and challenge_type = 'email_magic_link' and consumed_at is null and expires_at > now()
        returning email, redirect_path`, [digest(raw)]);
      if (found.rowCount !== 1) throw Object.assign(new Error("Invalid or expired login link"), { statusCode: 400 });
      const email = normalizeEmail(found.rows[0].email);
      const userId = await this.upsertIdentity(client, { provider: "email", subject: email, email, displayName: email.split("@")[0] });
      await client.query("commit");
      await this.createSession(response, userId, "email", client);
      return safeRedirect(found.rows[0].redirect_path);
    } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

export function csrfToken(request) {
  return parseCookies(request.headers.cookie)[CSRF_COOKIE] || null;
}
