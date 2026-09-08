import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PostgresAuthStore } from "../src/auth.js";

test("device credentials rotate atomically, preserve account boundaries, and keep manual tokens separate", async () => {
  const db = new PGlite();
  const user = randomUUID(), otherUser = randomUUID();
  try {
    await db.exec(`create table public.users (id uuid primary key, email text, display_name text, role text default 'user', status text default 'active');`);
    const migration = name => readFileSync(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8");
    // Resolve from the repository root, using the real production table definitions.
    const rootMigration = migration;
    await db.exec(rootMigration("0025_mcp_personal_access_tokens.sql"));
    await db.exec(rootMigration("0026_local_agent_bridge.sql").split("create table if not exists public.local_agent_tasks")[0]);
    await db.exec(rootMigration("0032_local_agent_bootstrap.sql"));
    await db.exec(rootMigration("0034_local_agent_device_identity.sql"));
    await db.query("insert into users (id) values ($1),($2)", [user, otherUser]);
    const query = async (sql, args) => { const result = await db.query(sql, args); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; };
    // PGlite has one connection; serialize borrowed transactions like a size-one pool.
    let tail = Promise.resolve();
    const pool = { query, async connect() {
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; }); await previous;
      return { query, release };
    } };
    const store = new PostgresAuthStore({ publicOrigin: "https://chat.example" }, { pool });
    const bootstrap = async device => {
      const value = await store.createLocalAgentBootstrap({ device_name: "DAVE", ...(device ? { device_id: device } : {}) });
      return { ...value, approval: new URLSearchParams(new URL(value.approval_url).hash.slice(1)).get("token") };
    };
    const approve = (value, owner = user) => store.approveLocalAgentBootstrap(owner, value.session_id, value.approval);
    const session = value => store.mcpSession({ headers: { authorization: `Bearer ${value.connector_token}` } });
    const device = randomUUID(), sameNameOtherDevice = randomUUID();
    const first = await bootstrap(device); await approve(first);
    const firstSession = await session(first);
    const originalConnection = randomUUID();
    await store.registerLocalAgent(user, { connection_id: originalConnection, device_name: "DAVE", device_id: device }, firstSession.token_id);
    // Reconnect reuses the same credential and connection.
    const reconnect = await store.registerLocalAgent(user, { connection_id: originalConnection, device_name: "DAVE", device_id: device }, firstSession.token_id);
    assert.equal(reconnect.connection_id, originalConnection);
    const separate = await bootstrap(sameNameOtherDevice); await approve(separate);
    const otherAccount = await bootstrap(device); await approve(otherAccount, otherUser);
    const manual = await store.createMcpToken(user, { name: "Local project · DAVE" });
    const rotated = await bootstrap(device); await approve(rotated);
    assert.equal(await session(first), null);
    assert.ok(await session(separate)); assert.ok(await session(otherAccount));
    await assert.rejects(approve(first), /replaced/);
    await approve(rotated); // Retrying an approval is harmless.
    const rotatedSession = await session(rotated);
    const registration = await store.registerLocalAgent(user, { connection_id: randomUUID(), device_name: "RENAMED", device_id: device }, rotatedSession.token_id);
    assert.equal(registration.connection_id, originalConnection);
    await assert.rejects(store.registerLocalAgent(user, { connection_id: originalConnection, device_name: "DAVE", device_id: sameNameOtherDevice }, rotatedSession.token_id), /does not match/);
    const list = await store.listMcpTokens(user);
    assert.equal(list.filter(x => x.device_id === device).length, 1);
    assert.equal(list.find(x => x.device_id === device).device_status, "online");
    assert.equal(list.find(x => x.token_id === manual.token_id).connection_kind, "manual");
    // Existing paired credentials bind on upgrade without minting another token.
    const legacy = await bootstrap(); await approve(legacy);
    const legacySession = await session(legacy), legacyDevice = randomUUID();
    await store.registerLocalAgent(user, { connection_id: legacyDevice, device_id: legacyDevice, device_name: "DAVE" }, legacySession.token_id);
    assert.equal((await store.listMcpTokens(user)).find(x => x.token_id === legacySession.token_id).device_id, legacyDevice);
    // Expiry asks for reconnect; it never silently falls back to a revoked token.
    await query("update mcp_personal_access_tokens set expires_at = now() - interval '1 second' where token_id = $1", [rotatedSession.token_id]);
    assert.equal((await store.listMcpTokens(user)).find(x => x.device_id === device).device_status, "reconnect_needed");
    assert.equal(await session(rotated), null);
    const [a,b] = await Promise.all([bootstrap(device), bootstrap(device)]);
    await Promise.all([approve(a), approve(b)]);
    assert.equal((await store.listMcpTokens(user)).filter(x => x.device_id === device).length, 1);
    assert.equal(await session(a), null); assert.ok(await session(b));
  } finally { await db.close(); }
});
