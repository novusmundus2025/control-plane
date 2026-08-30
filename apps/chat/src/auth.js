import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";

const SESSION_COOKIE = "__Host-mx_session";
const CSRF_COOKIE = "__Host-mx_csrf";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 10 * 60;

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

export function authConfigFromEnv(env = process.env) {
  return {
    required: !["0", "false", "no"].includes(String(env.MUNDUSX_CHAT_AUTH_REQUIRED ?? "true").toLowerCase()),
    databaseUrl: String(env.MUNDUSX_DATABASE_POOL_URL ?? env.DATABASE_URL ?? "").trim(),
    publicOrigin: String(env.MUNDUSX_PUBLIC_ORIGIN ?? "https://chat-u.mundusx.ai").replace(/\/$/, ""),
    githubClientId: String(env.MUNDUSX_GITHUB_CLIENT_ID ?? "").trim(),
    githubClientSecret: String(env.MUNDUSX_GITHUB_CLIENT_SECRET ?? "").trim(),
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
      github: Boolean(this.config.githubClientId && this.config.githubClientSecret),
      email: Boolean(this.config.resendApiKey && this.config.emailFrom),
    };
  }

  async session(request) {
    this.ensureReady();
    const raw = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const result = await this.pool.query(`
      select s.session_hash, s.csrf_hash, u.id, u.email, u.display_name, u.role,
        coalesce(jsonb_agg(jsonb_build_object(
          'grant_id', g.grant_id, 'tenant_id', g.tenant_id,
          'repository_source_id', g.repository_source_id,
          'allowed_path_prefixes', g.allowed_path_prefixes,
          'validation_profiles', g.validation_profiles,
          'allowed_execution_modes', g.allowed_execution_modes
        )) filter (where g.grant_id is not null), '[]'::jsonb) as harness_grants
      from public.user_sessions s
      join public.users u on u.id = s.user_id
      left join public.user_repository_grants g on g.user_id = u.id and g.status = 'active'
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
