mod contracts;
mod migrations;
mod state;
mod supabase;

use contracts::{
    is_trusted_identity_path, trust_path_label, AgentRegistration, ChatCompletionChoice,
    ChatCompletionChoiceMessage, ChatCompletionMundusX, ChatCompletionRequest,
    ChatCompletionResponse, Heartbeat, JobCompletion, JobRecord, JobRequest,
    NodePolicyOverrideInput, OperatorContributionPercentUpdate, OperatorNodePolicyOverrideUpdate,
    RuntimeMode,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use migrations::{applied_migrations, apply_migrations};
use serde::Serialize;
use state::{load_state, save_state, ControlPlaneState};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use supabase::SupabaseMirror;
use uuid::Uuid;

#[cfg(target_os = "macos")]
#[path = "../../../tools/macos_identity.rs"]
mod macos_identity;
#[cfg(target_os = "macos")]
use state::state_path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StorageSource {
    Supabase,
    LocalJsonFallback,
    LocalJsonOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperatorAuthMode {
    Enforced,
    ExplicitlyDisabled,
    MissingTokenDisabled,
}

const OPERATOR_TOKEN_ENV: &str = "MUNDUSX_OPERATOR_TOKEN";
const LEGACY_OPERATOR_TOKEN_ENV: &str = "OPENGPU_OPERATOR_TOKEN";
const AUTH_DISABLED_ENV: &str = "MUNDUSX_AUTH_DISABLED";
const CONTROL_PLANE_ENVIRONMENT_ENV: &str = "MUNDUSX_ENVIRONMENT";

impl OperatorAuthMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enforced => "enforced",
            Self::ExplicitlyDisabled => "explicitly-disabled",
            Self::MissingTokenDisabled => "missing-token-disabled",
        }
    }

    fn enforced(self) -> bool {
        matches!(self, Self::Enforced)
    }

    fn log_label(self) -> &'static str {
        match self {
            Self::Enforced => "enabled (token present)",
            Self::ExplicitlyDisabled => "disabled (MUNDUSX_AUTH_DISABLED=true)",
            Self::MissingTokenDisabled => "disabled (MUNDUSX_OPERATOR_TOKEN missing)",
        }
    }
}

impl StorageSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Supabase => "supabase",
            Self::LocalJsonFallback => "local-json-fallback",
            Self::LocalJsonOnly => "local-json-only",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct SupabaseSyncStatus {
    enabled: bool,
    restore_source: String,
    degraded: bool,
    failure_count: u64,
    last_error: Option<String>,
    last_error_at: Option<String>,
}

impl SupabaseSyncStatus {
    fn enabled(restore_source: StorageSource) -> Self {
        Self {
            enabled: true,
            restore_source: restore_source.as_str().to_string(),
            degraded: false,
            failure_count: 0,
            last_error: None,
            last_error_at: None,
        }
    }

    fn disabled(restore_source: StorageSource) -> Self {
        Self {
            enabled: false,
            restore_source: restore_source.as_str().to_string(),
            degraded: false,
            failure_count: 0,
            last_error: None,
            last_error_at: None,
        }
    }

    fn note_failure(&mut self, error: String) {
        self.degraded = true;
        self.failure_count = self.failure_count.saturating_add(1);
        self.last_error = Some(error);
        self.last_error_at = Some(now_unix_seconds());
    }

    fn summary(&self) -> String {
        if !self.enabled {
            format!("disabled ({})", self.restore_source)
        } else if self.degraded {
            format!("enabled (degraded, {})", self.restore_source)
        } else {
            format!("enabled ({})", self.restore_source)
        }
    }

    fn tone(&self) -> &'static str {
        if !self.enabled {
            "red"
        } else if self.degraded {
            "amber"
        } else {
            "green"
        }
    }
}

fn now_unix_seconds() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn json_response(status: &str, body: serde_json::Value) -> String {
    let payload = body.to_string();
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    )
}

fn text_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn html_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn job_status_path(job_id: &str) -> String {
    format!("/v1/jobs/{job_id}")
}

fn job_async_payload(record: &JobRecord) -> serde_json::Value {
    serde_json::json!({
        "job_id": record.job_id,
        "request_id": record.request_id,
        "status": record.status,
        "status_url": job_status_path(&record.job_id),
        "polling": {
            "method": "GET",
            "url": job_status_path(&record.job_id),
            "recommended_interval_seconds": 2,
            "default_timeout_seconds": 300
        },
        "job": record,
    })
}

fn chat_messages_to_prompt(messages: &[contracts::ChatMessage]) -> (Option<String>, String) {
    let mut system_messages = Vec::new();
    let mut conversation_lines = Vec::new();

    for message in messages {
        let role = message.role.trim().to_lowercase();
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }

        if role == "system" {
            system_messages.push(content.to_string());
        } else {
            conversation_lines.push(format!("{role}: {content}"));
        }
    }

    let system_prompt = if system_messages.is_empty() {
        None
    } else {
        Some(system_messages.join("\n"))
    };

    let prompt = if conversation_lines.is_empty() {
        messages
            .last()
            .map(|message| message.content.clone())
            .unwrap_or_default()
    } else {
        conversation_lines.join("\n")
    };

    (system_prompt, prompt)
}

fn now_unix_seconds_u64() -> u64 {
    now_unix_seconds().parse::<u64>().unwrap_or(0)
}

fn control_plane_bind_addr_from_env(
    port: Option<&str>,
    host: Option<&str>,
) -> Result<String, String> {
    let trimmed_host = host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let trimmed_port = port
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");

    if trimmed_port.is_empty() {
        let bind_host = if trimmed_host.is_empty() {
            "127.0.0.1"
        } else {
            trimmed_host
        };
        return Ok(format!("{bind_host}:8787"));
    }

    let parsed_port = trimmed_port
        .parse::<u16>()
        .map_err(|_| format!("invalid PORT value: {trimmed_port}"))?;
    let bind_host = if trimmed_host.is_empty() {
        "0.0.0.0"
    } else {
        trimmed_host
    };

    Ok(format!("{bind_host}:{parsed_port}"))
}

fn control_plane_bind_addr() -> Result<String, String> {
    control_plane_bind_addr_from_env(
        std::env::var("PORT").ok().as_deref(),
        std::env::var("MUNDUSX_CONTROL_PLANE_HOST").ok().as_deref(),
    )
}

fn deploy_fingerprint_from_env(
    explicit: Option<&str>,
    railway_git_commit_sha: Option<&str>,
    source_version: Option<&str>,
    git_commit_sha: Option<&str>,
    railway_deployment_id: Option<&str>,
) -> Option<String> {
    [
        explicit,
        railway_git_commit_sha,
        source_version,
        git_commit_sha,
        railway_deployment_id,
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(str::to_string)
}

fn deploy_fingerprint() -> Option<String> {
    deploy_fingerprint_from_env(
        std::env::var("MUNDUSX_DEPLOY_FINGERPRINT").ok().as_deref(),
        std::env::var("RAILWAY_GIT_COMMIT_SHA").ok().as_deref(),
        std::env::var("SOURCE_VERSION").ok().as_deref(),
        std::env::var("GIT_COMMIT_SHA").ok().as_deref(),
        std::env::var("RAILWAY_DEPLOYMENT_ID").ok().as_deref(),
    )
}

fn status_snapshot_with_deploy_fingerprint(
    mut snapshot: serde_json::Value,
    deploy_fingerprint: Option<String>,
) -> serde_json::Value {
    if let serde_json::Value::Object(fields) = &mut snapshot {
        fields.insert(
            "deploy_fingerprint".to_string(),
            deploy_fingerprint
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    snapshot
}

fn load_local_env() {
    let mut current = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };

    loop {
        let env_path = current.join(".env");
        if env_path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&env_path) {
                for line in raw.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    let Some((key, value)) = trimmed.split_once('=') else {
                        continue;
                    };
                    let key = key.trim();
                    let value = value.trim().trim_matches('"');
                    if !key.is_empty() && std::env::var_os(key).is_none() {
                        std::env::set_var(key, value);
                    }
                }
            }
            return;
        }

        if !current.pop() {
            return;
        }
    }
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn state_badge(state: &str) -> (&'static str, &'static str) {
    match state {
        "ready" => ("#12351f", "#8ef0aa"),
        "busy" => ("#3d2b0f", "#ffd27f"),
        "paused" => ("#3a2610", "#ffbf7a"),
        "stopped" => ("#3b1515", "#ff9d9d"),
        _ => ("#22304c", "#b8c7e8"),
    }
}

fn policy_badge(allowed: bool) -> (&'static str, &'static str, &'static str) {
    if allowed {
        ("#12351f", "#8ef0aa", "allowed")
    } else {
        ("#3b1515", "#ff9d9d", "blocked")
    }
}

fn trust_badge(trust_path: &str) -> (&'static str, &'static str, &'static str) {
    if is_trusted_identity_path(trust_path) {
        ("#12351f", "#8ef0aa", trust_path_label(trust_path))
    } else if trust_path == contracts::IDENTITY_TRUST_LOCAL_ENCRYPTED_FALLBACK {
        ("#3a2610", "#ffbf7a", trust_path_label(trust_path))
    } else {
        ("#22304c", "#b8c7e8", trust_path_label(trust_path))
    }
}

fn render_nodes(state: &ControlPlaneState) -> String {
    let nodes: Vec<_> = state.nodes.values().cloned().collect();
    if nodes.is_empty() {
        return r#"<div class="empty">No nodes have registered yet.</div>"#.to_string();
    }

    let mut html = String::from(
        r#"<div class="table">
        <div class="thead">
          <div>Node</div>
          <div>Host</div>
          <div>Trust</div>
          <div>Backend</div>
          <div>State</div>
          <div>Power</div>
          <div>Policy</div>
          <div>Updated</div>
        </div>"#,
    );

    for node in nodes {
        let (state_bg, state_fg) = state_badge(node.state.as_str());
        let (trust_bg, trust_fg, trust_label) = trust_badge(&node.identity_trust_path);
        let (policy_bg, policy_fg, policy_label) = policy_badge(node.policy_allowed);
        let battery = node
            .battery_percent
            .map(|value| format!("{value}%"))
            .unwrap_or_else(|| "unknown".to_string());
        let power = format!(
            "{} • {} • {}",
            node.power_source,
            if node.on_battery { "battery" } else { "AC" },
            battery
        );
        let worker_health = node
            .worker_health
            .as_ref()
            .map(|health| {
                let model_dir = health.model_dir.as_str();
                let model_name = health.model_name.as_deref().unwrap_or("none");
                let model_path = health.model_path.as_deref().unwrap_or("missing");
                let runtime_mode = health.runtime_mode.as_str();
                let checked_at = health.checked_at.as_str();
                let notes = if health.notes.is_empty() {
                    "no notes".to_string()
                } else {
                    health.notes.join(" • ")
                };
                format!(
                    r#"<div class="meta">worker: {} • model dir {} • model {} • {} • runtime {} • checked {} • llama-cli {} • BLAS {}</div><div class="meta">{}</div>"#,
                    if health.healthy { "healthy" } else { "degraded" },
                    escape_html(model_dir),
                    escape_html(model_name),
                    escape_html(model_path),
                    escape_html(runtime_mode),
                    escape_html(checked_at),
                    if health.llama_cli_available { "yes" } else { "no" },
                    if health.blas_device_available { "yes" } else { "no" },
                    escape_html(&notes)
                )
            })
            .unwrap_or_else(|| r#"<div class="meta">worker: unknown</div>"#.to_string());
        let policy_reason = node
            .policy_reason
            .as_ref()
            .map(|reason| format!(r#"<div class="meta">{}</div>"#, escape_html(reason)))
            .unwrap_or_default();

        html.push_str(&format!(
            r#"<div class="row">
              <div>
                <strong>{}</strong>
                <div class="meta">fingerprint {}</div>
                <div class="meta">cap {}% • {} GPU% free</div>
              </div>
              <div>
                <div>{}</div>
                <div class="meta">signed device</div>
              </div>
              <div>
                <span class="pill" style="background:{};color:{};">{}</span>
                <div class="meta">{}</div>
              </div>
              <div><span class="pill" style="background:{};color:{};">{}</span></div>
              <div>
                <span class="pill" style="background:{};color:{};">{}</span>
                <div class="meta" style="margin-top:6px;">{}</div>
              </div>
              <div>
                <div>{}</div>
                <div class="meta">{}</div>
                {}
              </div>
              <div>
                <span class="pill" style="background:{};color:{};">{}</span>
                {}
              </div>
              <div>{}</div>
            </div>"#,
            escape_html(&node.node_id),
            escape_html(&node.public_key_fingerprint),
            node.contribution_percent,
            node.available_gpu_percent,
            escape_html(&node.hostname),
            trust_bg,
            trust_fg,
            escape_html(trust_label),
            escape_html(&node.identity_trust_path),
            escape_html(&node.backend.to_string()),
            state_bg,
            state_fg,
            escape_html(&node.state.to_string()),
            state_bg,
            state_fg,
            escape_html(&node.state.to_string()),
            escape_html(&power),
            escape_html(&node.public_key_fingerprint),
            worker_health,
            policy_bg,
            policy_fg,
            policy_label,
            policy_reason,
            escape_html(&node.updated_at)
        ));
    }

    html.push_str("</div>");
    html
}

fn control_plane_home(
    state: &ControlPlaneState,
    storage_source: StorageSource,
    sync_status: &SupabaseSyncStatus,
) -> String {
    let snapshot = state.snapshot(storage_source.as_str());
    let nodes = snapshot["online_count"].as_u64().unwrap_or(0);
    let trusted = snapshot["trusted_count"].as_u64().unwrap_or(0);
    let paused = snapshot["paused_count"].as_u64().unwrap_or(0);
    let policy_blocked = snapshot["policy_blocked_count"].as_u64().unwrap_or(0);
    let job_events = snapshot["job_events"].as_u64().unwrap_or(0);
    let credits_ledger = snapshot["credits_ledger"].as_u64().unwrap_or(0);
    let credits_total = snapshot["credits_total"].as_f64().unwrap_or(0.0);
    let queued = snapshot["queued_job_count"].as_u64().unwrap_or(0);
    let assigned = snapshot["assigned_job_count"].as_u64().unwrap_or(0);
    let active_jobs = queued + assigned;
    let completed = snapshot["completed_job_count"].as_u64().unwrap_or(0);
    let failed = snapshot["failed_job_count"].as_u64().unwrap_or(0);
    let healthy_tone = "green";
    let storage_tone = if storage_source.as_str() == "supabase" {
        "green"
    } else {
        "amber"
    };
    let supabase = sync_status.summary();
    let supabase_tone = sync_status.tone();
    let deploy_fingerprint = deploy_fingerprint();
    let deploy_badge = deploy_fingerprint
        .as_deref()
        .map(|value| {
            format!(
                r#"<span class="pill pill-blue">deploy: {}</span>"#,
                escape_html(value)
            )
        })
        .unwrap_or_else(|| {
            r#"<span class="pill pill-amber">deploy: unavailable</span>"#.to_string()
        });

    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NovusX Control Plane</title>
    <style>
      :root {{
        color-scheme: dark;
        --bg: #080a0f;
        --surface: #101722;
        --surface-2: #151f2f;
        --panel: rgba(12, 18, 28, 0.92);
        --line: rgba(129, 161, 193, 0.18);
        --line-strong: rgba(237, 183, 63, 0.34);
        --text: #f3f7ff;
        --muted: #9ba9bd;
        --blue: #62d3ff;
        --green: #39d98a;
        --orange: #f18f3b;
        --amber: #edb73f;
        --red: #ff5c63;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        min-height: 100vh;
        background:
          linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.028) 1px, transparent 1px),
          radial-gradient(circle at 20% 0%, rgba(237, 183, 63, 0.18), transparent 34%),
          radial-gradient(circle at 78% 12%, rgba(98, 211, 255, 0.14), transparent 30%),
          linear-gradient(135deg, #06080d 0%, #111827 52%, #0a0c12 100%);
        background-size: 44px 44px, 44px 44px, auto, auto, auto;
        color: var(--text);
        font-family: Inter, "SF Pro Text", "Segoe UI", sans-serif;
      }}
      .wrap {{
        max-width: 1380px;
        margin: 0 auto;
        padding: 22px 20px 48px;
      }}
      .hero {{
        border: 1px solid var(--line-strong);
        background:
          linear-gradient(135deg, rgba(237, 183, 63, 0.12), transparent 22%),
          linear-gradient(110deg, rgba(98, 211, 255, 0.09), transparent 44%),
          var(--panel);
        border-radius: 8px;
        padding: 24px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }}
      .topline {{
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
        align-items: center;
        gap: 22px;
      }}
      .brand {{
        display: inline-flex;
        align-items: center;
        gap: 12px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }}
      .brand-mark {{
        width: 42px;
        height: 42px;
        border-radius: 8px;
        border: 1px solid rgba(237, 183, 63, 0.42);
        background: rgba(0, 0, 0, 0.32);
        object-fit: contain;
        padding: 4px;
        box-shadow: 0 0 28px rgba(237, 183, 63, 0.22);
      }}
      h1 {{
        margin: 14px 0 0;
        font-size: 48px;
        line-height: 1;
        letter-spacing: 0;
      }}
      .sub {{
        margin-top: 12px;
        color: var(--muted);
        line-height: 1.7;
        max-width: 74ch;
      }}
      .statusline {{
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }}
      .pill {{
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid transparent;
        font-weight: 700;
      }}
      .pill-green {{ background: rgba(15, 157, 88, 0.08); color: var(--green); border-color: rgba(15, 157, 88, 0.16); }}
      .pill-orange {{ background: rgba(196, 127, 27, 0.08); color: var(--orange); border-color: rgba(196, 127, 27, 0.16); }}
      .pill-amber {{ background: rgba(217, 119, 6, 0.08); color: var(--amber); border-color: rgba(217, 119, 6, 0.16); }}
      .pill-red {{ background: rgba(209, 67, 67, 0.08); color: var(--red); border-color: rgba(209, 67, 67, 0.16); }}
      .pill-blue {{ background: rgba(52, 82, 255, 0.08); color: var(--blue); border-color: rgba(52, 82, 255, 0.16); }}
      .pill-neutral {{ background: rgba(95, 107, 133, 0.08); color: var(--muted); border-color: rgba(95, 107, 133, 0.16); }}
      .grid {{
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin: 18px 0 24px;
      }}
      .card {{
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.018)), var(--surface);
        border-radius: 8px;
        padding: 16px;
      }}
      .card-label {{
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }}
      .card-value {{
        margin: 10px 0 12px;
        font-size: 30px;
        font-weight: 700;
      }}
      .section {{
        margin-top: 24px;
        border: 1px solid var(--line);
        background: rgba(12, 18, 28, 0.9);
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
      }}
      .section-head {{
        padding: 16px 20px;
        border-bottom: 1px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }}
      .section-title {{
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 14px;
      }}
      .section-body {{
        padding: 20px;
      }}
      .table .thead,
      .table .row {{
        display: grid;
        grid-template-columns: 1.3fr 1fr 0.7fr 0.7fr 1fr 1.1fr 0.7fr;
        gap: 14px;
        align-items: start;
      }}
      .table .thead {{
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
        padding-bottom: 12px;
        margin-bottom: 12px;
        border-bottom: 1px solid var(--line);
      }}
      .table .row {{
        padding: 14px 0;
        border-bottom: 1px solid rgba(15, 23, 42, 0.06);
      }}
      .table .row:last-child {{ border-bottom: 0; }}
      .meta {{
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }}
      .empty {{
        color: var(--muted);
        padding: 28px 0;
      }}
      .events {{
        display: grid;
        gap: 12px;
      }}
      .balance-grid {{
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }}
      .balance {{
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 14px 16px;
      }}
      .balance strong {{
        display: block;
        margin-bottom: 6px;
        font-size: 14px;
        color: var(--text);
        overflow-wrap: anywhere;
      }}
      .event {{
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 14px 16px;
      }}
      .event-top {{
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }}
      pre {{
        overflow: auto;
        margin: 12px 0 0;
        color: #31415f;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }}
      .error {{
        margin-top: 18px;
        border: 1px solid rgba(209, 67, 67, 0.22);
        background: rgba(209, 67, 67, 0.06);
        color: var(--red);
        padding: 14px 16px;
        border-radius: 8px;
      }}
      .links {{
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }}
      a {{
        color: var(--blue);
        text-decoration: none;
      }}
      a:hover {{ text-decoration: underline; }}
      code {{
        background: rgba(98, 211, 255, 0.08);
        border: 1px solid rgba(98, 211, 255, 0.18);
        padding: 2px 6px;
        border-radius: 8px;
        color: var(--text);
      }}
      .hero-panel {{
        border: 1px solid rgba(237, 183, 63, 0.25);
        border-radius: 8px;
        padding: 16px;
        background:
          linear-gradient(135deg, rgba(237, 183, 63, 0.16), transparent 58%),
          rgba(255, 255, 255, 0.04);
      }}
      .hero-panel-title {{
        color: var(--amber);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }}
      .hero-metrics {{
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin-top: 14px;
      }}
      .hero-metric {{
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: rgba(0, 0, 0, 0.18);
      }}
      .hero-metric strong {{
        display: block;
        margin-bottom: 4px;
        font-size: 24px;
      }}
      .hero-metric span {{
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }}
      @media (max-width: 1200px) {{
        .grid {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
        .topline {{ grid-template-columns: 1fr; }}
        .table .thead,
        .table .row {{ grid-template-columns: 1.1fr 0.9fr 0.7fr 0.7fr 1fr 1fr 0.7fr; }}
      }}
      @media (max-width: 820px) {{
        .grid {{ grid-template-columns: 1fr; }}
        h1 {{ font-size: 40px; }}
        .hero-metrics {{ grid-template-columns: 1fr; }}
        .table .thead {{ display: none; }}
        .table .row {{
          grid-template-columns: 1fr;
          gap: 10px;
          padding: 16px 0;
        }}
      }}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div class="topline">
            <div>
            <div class="brand"><img class="brand-mark" alt="NovusX control plane logo" src="https://github.com/user-attachments/assets/792dd24e-0253-43ef-9b88-d298189ca568" /> NovusX Command Deck</div>
            <h1>Control Plane</h1>
            <div class="sub">High-signal operator view for fleet readiness, routing pressure, policy gates, storage source, and audit trail.</div>
            <div class="statusline">
              <span class="pill pill-{healthy_tone}">healthy</span>
              <span class="pill pill-{storage_tone}">storage: {storage_source}</span>
              <span class="pill pill-{supabase_tone}">supabase: {supabase}</span>
              {deploy_badge}
            </div>
          </div>
          <div class="hero-panel" aria-label="Control plane command summary">
            <div class="hero-panel-title">Live command summary</div>
            <div class="hero-metrics">
              <div class="hero-metric"><strong>{nodes}</strong><span>nodes</span></div>
              <div class="hero-metric"><strong>{active_jobs}</strong><span>active jobs</span></div>
              <div class="hero-metric"><strong>{job_events}</strong><span>events</span></div>
            </div>
            <div class="links" style="margin-top: 14px;">
              <a href="/health">health</a>
              <a href="/v1/status">status json</a>
              <a href="/v1/nodes">nodes json</a>
              <a href="/v1/jobs">jobs json</a>
              <a href="/v1/credits">credits json</a>
            </div>
          </div>
        </div>

        <div class="grid">
          <div class="card"><div class="card-label">Online nodes</div><div class="card-value">{nodes}</div></div>
          <div class="card"><div class="card-label">Trusted nodes</div><div class="card-value">{trusted}</div></div>
          <div class="card"><div class="card-label">Paused nodes</div><div class="card-value">{paused}</div></div>
          <div class="card"><div class="card-label">Policy blocked</div><div class="card-value">{policy_blocked}</div></div>
          <div class="card"><div class="card-label">Job events</div><div class="card-value">{job_events}</div></div>
          <div class="card"><div class="card-label">Credits ledger</div><div class="card-value">{credits_ledger}</div></div>
          <div class="card"><div class="card-label">Total credits</div><div class="card-value">{credits_total:.2}</div></div>
          <div class="card"><div class="card-label">Queued jobs</div><div class="card-value">{queued}</div></div>
          <div class="card"><div class="card-label">Assigned jobs</div><div class="card-value">{assigned}</div></div>
          <div class="card"><div class="card-label">Completed jobs</div><div class="card-value">{completed}</div></div>
          <div class="card"><div class="card-label">Failed jobs</div><div class="card-value">{failed}</div></div>
        </div>

        <div class="error">
          Policy-aware nodes stay visible in the registry, but quiet nodes are excluded from scheduling.
          Current startup storage source: <code>{storage_source}</code>. Credits are accrued through the
          append-only ledger and exposed at <code>/v1/credits</code>. Supabase sync is
          <code>{supabase}</code>. Deploy fingerprint is exposed on <code>/health</code> and
          <code>/v1/status</code> for post-merge verification.
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2 class="section-title">Node details</h2>
          <div class="meta">{nodes} registered</div>
        </div>
        <div class="section-body">
          {node_rows}
        </div>
      </div>
    </div>
  </body>
</html>"#,
        node_rows = render_nodes(state),
        active_jobs = active_jobs,
        storage_source = escape_html(storage_source.as_str()),
        deploy_badge = deploy_badge
    )
}

struct RequestParts {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
}

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Eq, PartialEq)]
struct HttpRequestReadError {
    status: &'static str,
    message: String,
}

impl HttpRequestReadError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: "400 Bad Request",
            message: message.into(),
        }
    }

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            status: "413 Payload Too Large",
            message: message.into(),
        }
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

fn content_length_from_header_bytes(headers: &[u8]) -> Result<Option<usize>, HttpRequestReadError> {
    let header_text = std::str::from_utf8(headers)
        .map_err(|_| HttpRequestReadError::bad_request("request headers must be utf-8"))?;

    for line in header_text.split("\r\n").skip(1) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("content-length") {
            let length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| HttpRequestReadError::bad_request("invalid Content-Length"))?;
            if length > MAX_BODY_BYTES {
                return Err(HttpRequestReadError::payload_too_large(format!(
                    "request body exceeds {MAX_BODY_BYTES} bytes"
                )));
            }
            return Ok(Some(length));
        }
    }

    Ok(None)
}

fn read_http_request<R: Read>(reader: &mut R) -> Result<String, HttpRequestReadError> {
    let mut buffer = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let bytes_read = reader
            .read(&mut chunk)
            .map_err(|error| HttpRequestReadError::bad_request(error.to_string()))?;
        if bytes_read == 0 {
            return Err(HttpRequestReadError::bad_request("empty request"));
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            return Err(HttpRequestReadError::payload_too_large(format!(
                "request exceeds {} bytes",
                MAX_HEADER_BYTES + MAX_BODY_BYTES
            )));
        }
        if let Some(header_end) = find_header_end(&buffer) {
            break header_end;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(HttpRequestReadError::payload_too_large(format!(
                "request headers exceed {MAX_HEADER_BYTES} bytes"
            )));
        }
    };

    let content_length =
        content_length_from_header_bytes(&buffer[..header_end])?.unwrap_or_default();
    let expected_len = header_end
        .checked_add(content_length)
        .ok_or_else(|| HttpRequestReadError::payload_too_large("request is too large"))?;
    if expected_len > MAX_HEADER_BYTES + MAX_BODY_BYTES {
        return Err(HttpRequestReadError::payload_too_large(format!(
            "request exceeds {} bytes",
            MAX_HEADER_BYTES + MAX_BODY_BYTES
        )));
    }

    while buffer.len() < expected_len {
        let bytes_read = reader
            .read(&mut chunk)
            .map_err(|error| HttpRequestReadError::bad_request(error.to_string()))?;
        if bytes_read == 0 {
            return Err(HttpRequestReadError::bad_request(
                "request body ended before Content-Length was satisfied",
            ));
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
    }

    if content_length == 0 && buffer.len() > header_end {
        return Err(HttpRequestReadError::bad_request(
            "request body requires Content-Length",
        ));
    }

    String::from_utf8(buffer[..expected_len].to_vec())
        .map_err(|_| HttpRequestReadError::bad_request("request must be utf-8"))
}

fn parse_request(request: &str) -> RequestParts {
    let mut lines = request.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = BTreeMap::new();
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let body = request
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_string();
    RequestParts {
        method,
        path,
        headers,
        body,
    }
}

fn split_path_and_query(path: &str) -> (&str, Option<&str>) {
    if let Some((clean_path, query)) = path.split_once('?') {
        (clean_path, Some(query))
    } else {
        (path, None)
    }
}

fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    let query = query?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let candidate_key = parts.next().unwrap_or_default();
        let candidate_value = parts.next().unwrap_or_default();
        if candidate_key == key {
            return Some(candidate_value);
        }
    }
    None
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    headers
        .get(&key.to_ascii_lowercase())
        .map(|value| value.as_str())
}

fn requires_device_signature(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("POST", "/v1/register")
            | ("POST", "/v1/heartbeat")
            | ("GET", "/v1/jobs/next")
            | ("POST", "/v1/jobs/complete")
    )
}

fn requires_operator_auth(method: &str, path: &str) -> bool {
    if method == "GET" && path.starts_with("/v1/jobs/") {
        return true;
    }

    matches!(
        (method, path),
        ("GET", "/")
            | ("GET", "/v1/status")
            | ("GET", "/v1/nodes")
            | ("POST", "/v1/nodes/policy-override")
            | ("GET", "/v1/jobs")
            | ("GET", "/v1/job-events")
            | ("GET", "/v1/credits")
            | ("POST", "/v1/jobs")
            | ("POST", "/v1/chat/completions")
            | ("POST", "/v1/nodes/contribution-cap")
    )
}

fn node_public_key_hex(state: &Arc<Mutex<ControlPlaneState>>, node_id: &str) -> Option<String> {
    state
        .lock()
        .expect("state lock")
        .nodes
        .get(node_id)
        .map(|node| node.public_key_hex.clone())
}

fn verify_signature(
    public_key_hex: &str,
    method: &str,
    path: &str,
    timestamp: &str,
    body: &str,
    signature_hex: &str,
) -> Result<(), String> {
    let public_bytes = hex::decode(public_key_hex).map_err(|error| error.to_string())?;
    let message = format!("{method}\n{path}\n{timestamp}\n{body}");

    #[cfg(target_os = "macos")]
    if public_bytes.len() == 65 {
        let storage_dir = state_path()
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".mundusx-control-plane"));
        let verified = macos_identity::verify_message(
            &storage_dir,
            public_key_hex,
            message.as_bytes(),
            signature_hex,
        )
        .map_err(|error| error.to_string())?;
        if verified {
            return Ok(());
        }
        return Err("signature verification failed".to_string());
    }

    let public_bytes: [u8; 32] = public_bytes.try_into().map_err(|_| {
        "public key must be 32 bytes or macOS secure-enclave public key".to_string()
    })?;
    let verifying_key =
        VerifyingKey::from_bytes(&public_bytes).map_err(|error| error.to_string())?;
    let signature_bytes = hex::decode(signature_hex).map_err(|error| error.to_string())?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| error.to_string())?;
    verifying_key
        .verify(message.as_bytes(), &signature)
        .map_err(|error| error.to_string())
}

fn authorize_device_request(
    method: &str,
    route_path: &str,
    request_path: &str,
    headers: &BTreeMap<String, String>,
    body: &str,
    state: &Arc<Mutex<ControlPlaneState>>,
) -> Result<(), String> {
    if !requires_device_signature(method, route_path) {
        return Ok(());
    }

    let node_id = header_value(headers, "x-mundusx-node-id")
        .ok_or_else(|| "missing x-mundusx-node-id".to_string())?;
    let timestamp = header_value(headers, "x-mundusx-timestamp")
        .ok_or_else(|| "missing x-mundusx-timestamp".to_string())?;
    let signature = header_value(headers, "x-mundusx-signature")
        .ok_or_else(|| "missing x-mundusx-signature".to_string())?;

    let timestamp_value = timestamp
        .parse::<i64>()
        .map_err(|_| "invalid x-mundusx-timestamp".to_string())?;
    let current = now_unix_seconds()
        .parse::<i64>()
        .map_err(|_| "invalid current timestamp".to_string())?;
    if current.abs_diff(timestamp_value) > 300 {
        return Err("signature timestamp expired".to_string());
    }

    let public_key_hex = if route_path == "/v1/register" {
        let registration: AgentRegistration =
            serde_json::from_str(body).map_err(|error| error.to_string())?;
        if registration.node_id != node_id {
            return Err("node id header mismatch".to_string());
        }
        registration.public_key_hex
    } else {
        node_public_key_hex(state, node_id).ok_or_else(|| "unknown node".to_string())?
    };

    verify_signature(
        &public_key_hex,
        method,
        request_path,
        timestamp,
        body,
        signature,
    )
}

fn operator_auth_token() -> Option<String> {
    operator_auth_token_from_env(
        std::env::var(OPERATOR_TOKEN_ENV).ok().as_deref(),
        std::env::var(LEGACY_OPERATOR_TOKEN_ENV).ok().as_deref(),
    )
}

fn operator_auth_token_from_env(
    operator_token: Option<&str>,
    legacy_operator_token: Option<&str>,
) -> Option<String> {
    operator_token
        .or(legacy_operator_token)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn auth_disabled_flag_enabled(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(|value| {
            value.eq_ignore_ascii_case("true")
                || value == "1"
                || value.eq_ignore_ascii_case("yes")
                || value.eq_ignore_ascii_case("on")
        })
        .unwrap_or(false)
}

fn operator_auth_mode_from_env(
    auth_disabled: Option<&str>,
    operator_token: Option<&str>,
    legacy_operator_token: Option<&str>,
) -> OperatorAuthMode {
    if auth_disabled_flag_enabled(auth_disabled) {
        return OperatorAuthMode::ExplicitlyDisabled;
    }

    match operator_auth_token_from_env(operator_token, legacy_operator_token) {
        Some(_) => OperatorAuthMode::Enforced,
        None => OperatorAuthMode::MissingTokenDisabled,
    }
}

fn operator_auth_mode() -> OperatorAuthMode {
    operator_auth_mode_from_env(
        std::env::var(AUTH_DISABLED_ENV).ok().as_deref(),
        std::env::var(OPERATOR_TOKEN_ENV).ok().as_deref(),
        std::env::var(LEGACY_OPERATOR_TOKEN_ENV).ok().as_deref(),
    )
}

fn control_plane_environment_from_env(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_ascii_lowercase()
}

fn auth_disabled_allowed_in_environment(environment: &str) -> bool {
    matches!(
        environment,
        "local" | "dev" | "development" | "test" | "uat"
    )
}

fn operator_auth_startup_config_error(
    auth_disabled: Option<&str>,
    environment: Option<&str>,
) -> Option<String> {
    if !auth_disabled_flag_enabled(auth_disabled) {
        return None;
    }

    let environment = control_plane_environment_from_env(environment);
    if auth_disabled_allowed_in_environment(&environment) {
        return None;
    }

    Some(format!(
        "{AUTH_DISABLED_ENV}=true is only allowed when {CONTROL_PLANE_ENVIRONMENT_ENV} is local, dev, development, test, or uat; current environment is {environment}"
    ))
}

fn operator_auth_startup_error() -> Option<String> {
    operator_auth_startup_config_error(
        std::env::var(AUTH_DISABLED_ENV).ok().as_deref(),
        std::env::var(CONTROL_PLANE_ENVIRONMENT_ENV).ok().as_deref(),
    )
}

fn legacy_operator_token_warning() -> Option<String> {
    let canonical_present = std::env::var(OPERATOR_TOKEN_ENV)
        .ok()
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false);
    let legacy_present = std::env::var(LEGACY_OPERATOR_TOKEN_ENV)
        .ok()
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false);

    if legacy_present && !canonical_present {
        Some(format!(
            "{LEGACY_OPERATOR_TOKEN_ENV} is deprecated; set {OPERATOR_TOKEN_ENV} instead. Using the legacy token for this process."
        ))
    } else {
        None
    }
}

fn authorize_operator_request(
    method: &str,
    route_path: &str,
    headers: &BTreeMap<String, String>,
) -> Result<(), String> {
    if !requires_operator_auth(method, route_path) {
        return Ok(());
    }

    if !operator_auth_mode().enforced() {
        return Ok(());
    }

    let expected_token =
        operator_auth_token().expect("operator auth mode requires a non-empty token");

    let authorization = header_value(headers, "authorization")
        .or_else(|| header_value(headers, "x-mundusx-operator-token"))
        .ok_or_else(|| "missing operator authorization".to_string())?;

    let presented = authorization
        .strip_prefix("Bearer ")
        .or_else(|| authorization.strip_prefix("bearer "))
        .unwrap_or(authorization)
        .trim();

    if presented
        .as_bytes()
        .ct_eq(expected_token.as_bytes())
        .unwrap_u8()
        == 0
    {
        return Err("invalid operator token".to_string());
    }

    Ok(())
}

fn note_supabase_failure(sync_status: &Arc<Mutex<SupabaseSyncStatus>>, error: String) {
    if let Ok(mut guard) = sync_status.lock() {
        guard.note_failure(error);
    }
}

fn handle_connection(
    mut stream: TcpStream,
    state: Arc<Mutex<ControlPlaneState>>,
    sync_status: Arc<Mutex<SupabaseSyncStatus>>,
    supabase: Option<&SupabaseMirror>,
    storage_source: StorageSource,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let request_text = match read_http_request(&mut stream) {
        Ok(request_text) => request_text,
        Err(error) => {
            let _ = stream.write_all(text_response(error.status, &error.message).as_bytes());
            return;
        }
    };

    let request = parse_request(&request_text);
    let (clean_path, query) = split_path_and_query(&request.path);

    if let Err(error) = authorize_device_request(
        &request.method,
        clean_path,
        &request.path,
        &request.headers,
        &request.body,
        &state,
    ) {
        let _ = stream.write_all(
            json_response("401 Unauthorized", serde_json::json!({ "error": error })).as_bytes(),
        );
        return;
    }

    if let Err(error) = authorize_operator_request(&request.method, clean_path, &request.headers) {
        let _ = stream.write_all(
            json_response("401 Unauthorized", serde_json::json!({ "error": error })).as_bytes(),
        );
        return;
    }

    let response = match (request.method.as_str(), clean_path) {
        ("GET", "/") => {
            let snapshot = state.lock().expect("state lock");
            let sync_snapshot = sync_status.lock().expect("sync status lock").clone();
            html_response(
                "200 OK",
                &control_plane_home(&snapshot, storage_source, &sync_snapshot),
            )
        }
        ("GET", "/health") => {
            let snapshot = state
                .lock()
                .expect("state lock")
                .snapshot(storage_source.as_str());
            let sync_snapshot = sync_status.lock().expect("sync status lock").clone();
            let deploy_fingerprint = deploy_fingerprint();
            let auth_mode = operator_auth_mode();
            let environment = control_plane_environment_from_env(
                std::env::var(CONTROL_PLANE_ENVIRONMENT_ENV).ok().as_deref(),
            );
            json_response(
                "200 OK",
                serde_json::json!({
                    "status": "ok",
                    "storage_source": storage_source.as_str(),
                    "supabase": sync_snapshot.summary(),
                    "supabase_sync": sync_snapshot,
                    "deploy_fingerprint": deploy_fingerprint,
                    "environment": environment,
                    "operator_auth_enforced": auth_mode.enforced(),
                    "operator_auth_mode": auth_mode.as_str(),
                    "snapshot": snapshot,
                }),
            )
        }
        ("GET", "/v1/status") => {
            let snapshot = state
                .lock()
                .expect("state lock")
                .snapshot(storage_source.as_str());
            json_response(
                "200 OK",
                status_snapshot_with_deploy_fingerprint(snapshot, deploy_fingerprint()),
            )
        }
        ("GET", "/v1/nodes") => {
            let snapshot = state.lock().expect("state lock").nodes_snapshot();
            json_response("200 OK", snapshot)
        }
        ("POST", "/v1/nodes/contribution-cap") => {
            match serde_json::from_str::<OperatorContributionPercentUpdate>(&request.body) {
                Ok(update) => {
                    let mut guard = state.lock().expect("state lock");
                    match guard.set_operator_contribution_percent(
                        &update.node_id,
                        update.contribution_percent,
                    ) {
                        Ok(record) => {
                            let event = guard.record_job_event(
                                Some(record.node_id.clone()),
                                None,
                                "operator_contribution_percent_updated",
                                serde_json::json!({
                                    "node_id": record.node_id,
                                    "contribution_percent": record.contribution_percent,
                                    "reported_contribution_percent": record.reported_contribution_percent,
                                    "operator_contribution_percent": record.operator_contribution_percent,
                                }),
                                now_unix_seconds(),
                            );
                            if let Err(error) = save_state(&guard) {
                                eprintln!("failed to save control-plane state: {error}");
                            }
                            if let Some(db) = supabase.as_ref() {
                                if let Err(error) = db.record_job_event(&event) {
                                    eprintln!("database operator cap event skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                            }
                            json_response("200 OK", serde_json::to_value(record).expect("json"))
                        }
                        Err(error) => {
                            json_response("400 Bad Request", serde_json::json!({ "error": error }))
                        }
                    }
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("GET", "/v1/jobs") => {
            let snapshot = state.lock().expect("state lock").jobs_snapshot();
            json_response("200 OK", snapshot)
        }
        ("GET", path) if path.starts_with("/v1/jobs/") => {
            let job_id = path.trim_start_matches("/v1/jobs/");
            if job_id.is_empty() || job_id.contains('/') {
                json_response(
                    "404 Not Found",
                    serde_json::json!({ "error": "job not found" }),
                )
            } else {
                let record = state.lock().expect("state lock").jobs.get(job_id).cloned();
                match record {
                    Some(record) => json_response("200 OK", job_async_payload(&record)),
                    None => json_response(
                        "404 Not Found",
                        serde_json::json!({ "error": "job not found" }),
                    ),
                }
            }
        }
        ("GET", "/v1/job-events") => {
            let snapshot = state.lock().expect("state lock").job_events_snapshot();
            json_response("200 OK", snapshot)
        }
        ("GET", "/v1/credits") => {
            let snapshot = state.lock().expect("state lock").credits_snapshot();
            json_response("200 OK", snapshot)
        }
        ("GET", "/v1/jobs/next") => {
            if let Some(node_id) = query_param(query, "node_id") {
                let mut guard = state.lock().expect("state lock");
                let claim = guard.claim_job(node_id, now_unix_seconds());
                if let Some(job) = claim.job.as_ref() {
                    let event = guard.record_job_event(
                        Some(node_id.to_string()),
                        Some(job.job_id.clone()),
                        "job_claimed",
                        serde_json::to_value(job).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database claim sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                }
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                json_response("200 OK", serde_json::to_value(claim).expect("json"))
            } else {
                text_response("400 Bad Request", "missing node_id")
            }
        }
        ("POST", "/v1/register") => {
            match serde_json::from_str::<AgentRegistration>(&request.body) {
                Ok(registration) => {
                    let registration_clone = registration.clone();
                    let mut guard = state.lock().expect("state lock");
                    let record = guard.register(registration);
                    let event = guard.record_job_event(
                        Some(record.node_id.clone()),
                        None,
                        "registration",
                        serde_json::to_value(&record).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Err(error) = save_state(&guard) {
                        eprintln!("failed to save control-plane state: {error}");
                    }
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_registration(&registration_clone) {
                            eprintln!("database registration sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database registration event skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                    json_response("200 OK", serde_json::to_value(record).expect("json"))
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/v1/nodes/policy-override") => {
            match serde_json::from_str::<OperatorNodePolicyOverrideUpdate>(&request.body) {
                Ok(update) => {
                    let actor = update
                        .actor
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("operator")
                        .to_string();
                    let reason = update
                        .reason
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    let override_input = if let Some(target) = update.target {
                        if let Some(reason) = reason.clone() {
                            Some(NodePolicyOverrideInput {
                                target,
                                reason,
                                actor: actor.clone(),
                                updated_at: now_unix_seconds(),
                            })
                        } else {
                            return stream.write_all(
                                json_response(
                                    "400 Bad Request",
                                    serde_json::json!({ "error": "reason is required when setting a policy override" }),
                                )
                                .as_bytes(),
                            ).unwrap_or(());
                        }
                    } else {
                        None
                    };

                    let mut guard = state.lock().expect("state lock");
                    match guard.set_node_policy_override(&update.node_id, override_input) {
                        Ok(record) => {
                            let event = guard.record_job_event(
                                Some(record.node_id.clone()),
                                None,
                                "operator_policy_override_updated",
                                serde_json::json!({
                                    "node_id": record.node_id,
                                    "target": record.operator_policy_override.as_ref().map(|value| value.target.as_str()),
                                    "reason": reason,
                                    "actor": actor,
                                    "reported_state": record.reported_state,
                                    "state": record.state,
                                    "computed_policy_allowed": record.computed_policy_allowed,
                                    "computed_policy_reason": record.computed_policy_reason,
                                    "policy_allowed": record.policy_allowed,
                                    "policy_reason": record.policy_reason,
                                    "operator_policy_override": record.operator_policy_override,
                                }),
                                now_unix_seconds(),
                            );
                            if let Err(error) = save_state(&guard) {
                                eprintln!("failed to save control-plane state: {error}");
                            }
                            if let Some(db) = supabase.as_ref() {
                                if let Err(error) = db.record_node_snapshot(&record) {
                                    eprintln!("database node override sync skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                                if let Err(error) = db.record_job_event(&event) {
                                    eprintln!("database node override event skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                            }
                            json_response("200 OK", serde_json::to_value(record).expect("json"))
                        }
                        Err(error) => {
                            json_response("400 Bad Request", serde_json::json!({ "error": error }))
                        }
                    }
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/v1/heartbeat") => match serde_json::from_str::<Heartbeat>(&request.body) {
            Ok(heartbeat) => {
                let heartbeat_clone = heartbeat.clone();
                let mut guard = state.lock().expect("state lock");
                let record = guard.heartbeat(heartbeat, now_unix_seconds());
                let event = guard.record_job_event(
                    Some(record.node_id.clone()),
                    None,
                    "heartbeat",
                    serde_json::to_value(&record).expect("json"),
                    now_unix_seconds(),
                );
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                if let Some(db) = supabase.as_ref() {
                    if let Err(error) = db.record_heartbeat(&heartbeat_clone, &record) {
                        eprintln!("database heartbeat sync skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                    if let Err(error) = db.record_job_event(&event) {
                        eprintln!("database heartbeat event skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                }
                json_response("200 OK", serde_json::to_value(record).expect("json"))
            }
            Err(error) => json_response(
                "400 Bad Request",
                serde_json::json!({ "error": error.to_string() }),
            ),
        },
        ("POST", "/v1/jobs") => match serde_json::from_str::<JobRequest>(&request.body) {
            Ok(request) => {
                let mut guard = state.lock().expect("state lock");
                let record = guard.submit_job(request, now_unix_seconds());
                let event = guard.record_job_event(
                    None,
                    Some(record.job_id.clone()),
                    "job_submitted",
                    serde_json::to_value(&record).expect("json"),
                    now_unix_seconds(),
                );
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                if let Some(db) = supabase.as_ref() {
                    if let Err(error) = db.record_job(&record) {
                        eprintln!("database job sync skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                    if let Err(error) = db.record_job_event(&event) {
                        eprintln!("database job event skipped: {error}");
                        note_supabase_failure(&sync_status, error);
                    }
                }
                json_response("202 Accepted", job_async_payload(&record))
            }
            Err(error) => json_response(
                "400 Bad Request",
                serde_json::json!({ "error": error.to_string() }),
            ),
        },
        ("POST", "/v1/chat/completions") => {
            match serde_json::from_str::<ChatCompletionRequest>(&request.body) {
                Ok(request_body) => {
                    if request_body.stream.unwrap_or(false) {
                        if let Err(error) = stream.write_all(
                            json_response(
                                "400 Bad Request",
                                serde_json::json!({
                                    "error": "streaming chat completions are not supported yet"
                                }),
                            )
                            .as_bytes(),
                        ) {
                            eprintln!("failed to write response: {error}");
                        }
                        return;
                    }

                    let (system_prompt, prompt) = chat_messages_to_prompt(&request_body.messages);
                    let job_request = JobRequest {
                        request_id: format!("chatcmpl-{}", Uuid::new_v4().simple()),
                        prompt,
                        preferred_backend: crate::contracts::Backend::Auto,
                        runtime_mode: RuntimeMode::Interactive,
                        stream: false,
                        model: Some(request_body.model.clone()),
                        system_prompt,
                        max_tokens: request_body.max_tokens,
                        temperature: request_body.temperature,
                        top_p: request_body.top_p,
                        seed: request_body.seed,
                    };

                    let mut guard = state.lock().expect("state lock");
                    let record = guard.submit_job(job_request, now_unix_seconds());
                    let event = guard.record_job_event(
                        None,
                        Some(record.job_id.clone()),
                        "chat_completion_submitted",
                        serde_json::to_value(&record).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Err(error) = save_state(&guard) {
                        eprintln!("failed to save control-plane state: {error}");
                    }
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_job(&record) {
                            eprintln!("database chat completion sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database chat completion event skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }

                    let response = ChatCompletionResponse {
                        id: format!("chatcmpl-{}", Uuid::new_v4().simple()),
                        object: "chat.completion".to_string(),
                        created: now_unix_seconds_u64(),
                        model: request_body.model,
                        choices: vec![ChatCompletionChoice {
                            index: 0,
                            message: ChatCompletionChoiceMessage {
                                role: "assistant".to_string(),
                                content: String::new(),
                            },
                            finish_reason: "queued".to_string(),
                        }],
                        mundusx: ChatCompletionMundusX {
                            job_id: record.job_id.clone(),
                            request_id: record.request_id.clone(),
                            status: record.status.to_string(),
                        },
                    };

                    json_response("200 OK", serde_json::to_value(response).expect("json"))
                }
                Err(error) => json_response(
                    "400 Bad Request",
                    serde_json::json!({ "error": error.to_string() }),
                ),
            }
        }
        ("POST", "/v1/jobs/complete") => match serde_json::from_str::<JobCompletion>(&request.body)
        {
            Ok(completion) => {
                let completion_clone = completion.clone();
                let mut guard = state.lock().expect("state lock");
                let record = guard.complete_job(completion, now_unix_seconds());
                if let Some(job) = record.as_ref() {
                    let completed_at = job.completed_at.clone().unwrap_or_else(now_unix_seconds);
                    let event_type = if matches!(job.status, crate::contracts::JobStatus::Completed)
                    {
                        "job_completed"
                    } else {
                        "job_failed"
                    };
                    let event = guard.record_job_event(
                        job.assigned_node_id.clone(),
                        Some(job.job_id.clone()),
                        event_type,
                        serde_json::to_value(job).expect("json"),
                        now_unix_seconds(),
                    );
                    if let Some(db) = supabase.as_ref() {
                        if let Err(error) = db.record_job_event(&event) {
                            eprintln!("database completion event skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                    if matches!(job.status, crate::contracts::JobStatus::Completed) {
                        if let Some(award) = guard.award_job_reward(job, completed_at) {
                            let award_event = guard.record_job_event(
                                award.device_id.clone(),
                                award.job_id.clone(),
                                "credit_awarded",
                                serde_json::to_value(&award).expect("json"),
                                award.created_at.clone(),
                            );
                            if let Some(db) = supabase.as_ref() {
                                if let Err(error) = db.record_credit_award(&award) {
                                    eprintln!("database credit sync skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                                if let Err(error) = db.record_job_event(&award_event) {
                                    eprintln!("database credit event skipped: {error}");
                                    note_supabase_failure(&sync_status, error);
                                }
                            }
                        }
                    }
                }
                if let Err(error) = save_state(&guard) {
                    eprintln!("failed to save control-plane state: {error}");
                }
                if let Some(db) = supabase.as_ref() {
                    if let Some(job) = record.as_ref() {
                        if let Err(error) = db.record_job_completion(&completion_clone, job) {
                            eprintln!("database completion sync skipped: {error}");
                            note_supabase_failure(&sync_status, error);
                        }
                    }
                }
                match record {
                    Some(record) => {
                        json_response("200 OK", serde_json::to_value(record).expect("json"))
                    }
                    None => json_response(
                        "404 Not Found",
                        serde_json::json!({ "error": "job not found" }),
                    ),
                }
            }
            Err(error) => json_response(
                "400 Bad Request",
                serde_json::json!({ "error": error.to_string() }),
            ),
        },
        _ => text_response("404 Not Found", "not found"),
    };

    let _ = stream.write_all(response.as_bytes());
}

fn main() {
    load_local_env();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|arg| arg.as_str()) == Some("migrate") {
        match std::env::var("DATABASE_URL") {
            Ok(database_url) => match apply_migrations(&database_url) {
                Ok(applied) => {
                    if applied.is_empty() {
                        println!("no migrations to apply");
                    } else {
                        for migration in applied {
                            println!(
                                "applied {}_{} ({})",
                                migration.version,
                                migration.name,
                                migration.path.display()
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!("migration failed: {error}");
                    std::process::exit(1);
                }
            },
            Err(_) => {
                eprintln!("DATABASE_URL is required for migrate");
                std::process::exit(1);
            }
        }
        return;
    }

    let supabase = SupabaseMirror::from_env();
    let bind_addr = control_plane_bind_addr().expect("resolve bind address");
    let listener = TcpListener::bind(&bind_addr).expect("bind control plane");
    let (restored_state, storage_source, sync_status) = match supabase.as_ref() {
        Some(db) => match db.restore_state() {
            Ok(state) => {
                println!("restore: supabase");
                (
                    state,
                    StorageSource::Supabase,
                    SupabaseSyncStatus::enabled(StorageSource::Supabase),
                )
            }
            Err(error) => {
                eprintln!("supabase restore skipped: {error}");
                let mut status = SupabaseSyncStatus::enabled(StorageSource::LocalJsonFallback);
                status.note_failure(format!("restore failed: {error}"));
                (
                    load_state().ok().flatten().unwrap_or_default(),
                    StorageSource::LocalJsonFallback,
                    status,
                )
            }
        },
        None => {
            println!("restore: local-json");
            (
                load_state().ok().flatten().unwrap_or_default(),
                StorageSource::LocalJsonOnly,
                SupabaseSyncStatus::disabled(StorageSource::LocalJsonOnly),
            )
        }
    };
    let state = Arc::new(Mutex::new(restored_state));
    let sync_status = Arc::new(Mutex::new(sync_status));

    println!("NovusX control plane listening on http://{bind_addr}");
    println!(
        "supabase: {}",
        sync_status.lock().expect("sync status lock").summary()
    );
    println!("storage_source: {}", storage_source.as_str());
    if let Ok(database_url) = std::env::var("DATABASE_URL") {
        match applied_migrations(&database_url) {
            Ok(applied) => println!("migrations: {} applied", applied.len()),
            Err(error) => eprintln!("migration status unavailable: {error}"),
        }
    }
    if let Some(error) = operator_auth_startup_error() {
        eprintln!("operatorAuth error: {error}");
        std::process::exit(1);
    }
    println!("operatorAuth: {}", operator_auth_mode().log_label());
    println!(
        "environment: {}",
        control_plane_environment_from_env(
            std::env::var(CONTROL_PLANE_ENVIRONMENT_ENV).ok().as_deref()
        )
    );
    if let Some(warning) = legacy_operator_token_warning() {
        eprintln!("operatorAuth warning: {warning}");
    }
    println!("home: GET /");
    println!("health: GET /health");
    println!("status: GET /v1/status");
    println!("nodes: GET /v1/nodes");
    println!("update cap: POST /v1/nodes/contribution-cap");
    println!("jobs: GET /v1/jobs");
    println!("register: POST /v1/register");
    println!("heartbeat: POST /v1/heartbeat");
    println!("submit job: POST /v1/jobs");
    println!("claim job: GET /v1/jobs/next?node_id=...");
    println!("complete job: POST /v1/jobs/complete");

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let sync_status = Arc::clone(&sync_status);
                handle_connection(
                    stream,
                    state,
                    sync_status,
                    supabase.as_ref(),
                    storage_source,
                );
            }
            Err(error) => eprintln!("incoming connection error: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        auth_disabled_flag_enabled, control_plane_bind_addr_from_env, control_plane_home,
        deploy_fingerprint_from_env, job_async_payload, operator_auth_mode_from_env,
        operator_auth_startup_config_error, operator_auth_token_from_env, parse_request,
        read_http_request, requires_operator_auth, status_snapshot_with_deploy_fingerprint,
        HttpRequestReadError, OperatorAuthMode, StorageSource, SupabaseSyncStatus,
        AUTH_DISABLED_ENV, CONTROL_PLANE_ENVIRONMENT_ENV, LEGACY_OPERATOR_TOKEN_ENV,
        MAX_BODY_BYTES, OPERATOR_TOKEN_ENV,
    };
    use crate::contracts::{Backend, JobRequest, RuntimeMode};
    use crate::state::ControlPlaneState;
    use std::io::{self, Read};

    struct ChunkedReader {
        chunks: Vec<Vec<u8>>,
        index: usize,
    }

    impl ChunkedReader {
        fn new(chunks: Vec<&[u8]>) -> Self {
            Self {
                chunks: chunks.into_iter().map(|chunk| chunk.to_vec()).collect(),
                index: 0,
            }
        }
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.index >= self.chunks.len() {
                return Ok(0);
            }
            let chunk = &self.chunks[self.index];
            let len = chunk.len().min(buffer.len());
            buffer[..len].copy_from_slice(&chunk[..len]);
            self.index += 1;
            Ok(len)
        }
    }

    #[test]
    fn defaults_to_localhost_when_port_is_missing() {
        let bind_addr = control_plane_bind_addr_from_env(None, None).expect("bind addr");
        assert_eq!(bind_addr, "127.0.0.1:8787");
    }

    #[test]
    fn uses_railway_friendly_bind_when_port_is_present() {
        let bind_addr = control_plane_bind_addr_from_env(Some("3000"), None).expect("bind addr");
        assert_eq!(bind_addr, "0.0.0.0:3000");
    }

    #[test]
    fn honors_explicit_host_override() {
        let bind_addr =
            control_plane_bind_addr_from_env(Some("8787"), Some("127.0.0.1")).expect("bind addr");
        assert_eq!(bind_addr, "127.0.0.1:8787");
    }

    #[test]
    fn prefers_explicit_deploy_fingerprint_over_host_metadata() {
        let fingerprint = deploy_fingerprint_from_env(
            Some("manual-fingerprint"),
            Some("railway-sha"),
            Some("source-version"),
            Some("git-sha"),
            Some("deploy-id"),
        );

        assert_eq!(fingerprint.as_deref(), Some("manual-fingerprint"));
    }

    #[test]
    fn falls_back_to_railway_commit_sha_for_deploy_fingerprint() {
        let fingerprint =
            deploy_fingerprint_from_env(None, Some("abcdef1234567890"), None, None, None);

        assert_eq!(fingerprint.as_deref(), Some("abcdef1234567890"));
    }

    #[test]
    fn returns_none_when_no_deploy_fingerprint_metadata_is_available() {
        let fingerprint = deploy_fingerprint_from_env(None, None, None, None, None);

        assert_eq!(fingerprint, None);
    }

    #[test]
    fn status_snapshot_exposes_deploy_fingerprint() {
        let snapshot = status_snapshot_with_deploy_fingerprint(
            serde_json::json!({
                "storage_source": "supabase",
                "queued_job_count": 0
            }),
            Some("abcdef1234567890".to_string()),
        );

        assert_eq!(snapshot["deploy_fingerprint"], "abcdef1234567890");
        assert_eq!(snapshot["storage_source"], "supabase");
    }

    #[test]
    fn home_page_renders_command_deck_shell() {
        let mut state = ControlPlaneState::default();
        state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "Summarize operator state".to_string(),
                preferred_backend: Backend::Auto,
                runtime_mode: RuntimeMode::Local,
                stream: false,
                model: Some("HuggingFaceTB/SmolLM2-135M-Instruct".to_string()),
                system_prompt: None,
                max_tokens: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "123".to_string(),
        );

        let html = control_plane_home(
            &state,
            StorageSource::LocalJsonFallback,
            &SupabaseSyncStatus::enabled(StorageSource::LocalJsonFallback),
        );

        assert!(html.contains("NovusX Command Deck"));
        assert!(html.contains("Control Plane"));
        assert!(html.contains("NovusX control plane logo"));
        assert!(html.contains("792dd24e-0253-43ef-9b88-d298189ca568"));
        assert!(html.contains("Live command summary"));
        assert!(html.contains("<strong>1</strong><span>active jobs</span>"));
        assert!(html.contains("color-scheme: dark"));
    }

    #[test]
    fn rejects_invalid_port_values() {
        let error = control_plane_bind_addr_from_env(Some("abc"), None).expect_err("invalid");
        assert_eq!(error, "invalid PORT value: abc");
    }

    #[test]
    fn detects_explicit_auth_disabled_flag() {
        assert!(auth_disabled_flag_enabled(Some("true")));
        assert!(auth_disabled_flag_enabled(Some("1")));
        assert!(!auth_disabled_flag_enabled(Some("false")));
        assert!(!auth_disabled_flag_enabled(None));
    }

    #[test]
    fn operator_auth_mode_honors_explicit_disable_over_token() {
        let mode = operator_auth_mode_from_env(Some("true"), Some("secret"), None);

        assert_eq!(mode, OperatorAuthMode::ExplicitlyDisabled);
        assert!(!mode.enforced());
        assert_eq!(mode.as_str(), "explicitly-disabled");
    }

    #[test]
    fn operator_auth_mode_enforces_when_token_is_present() {
        let mode = operator_auth_mode_from_env(None, Some("secret"), None);

        assert_eq!(mode, OperatorAuthMode::Enforced);
        assert!(mode.enforced());
        assert_eq!(mode.as_str(), "enforced");
    }

    #[test]
    fn operator_auth_mode_enforces_when_legacy_token_is_present() {
        let mode = operator_auth_mode_from_env(None, None, Some("legacy-secret"));

        assert_eq!(mode, OperatorAuthMode::Enforced);
        assert!(mode.enforced());
    }

    #[test]
    fn operator_auth_token_prefers_canonical_over_legacy() {
        let token =
            operator_auth_token_from_env(Some(" canonical "), Some(" legacy ")).expect("token");

        assert_eq!(token, "canonical");
    }

    #[test]
    fn operator_auth_token_falls_back_to_legacy() {
        let token =
            operator_auth_token_from_env(None, Some(" legacy-secret ")).expect("legacy token");

        assert_eq!(token, "legacy-secret");
    }

    #[test]
    fn readme_documents_operator_auth_env_names() {
        let readme = include_str!("../../../README.md");

        assert!(readme.contains(OPERATOR_TOKEN_ENV));
        assert!(readme.contains(LEGACY_OPERATOR_TOKEN_ENV));
        assert!(readme.contains("Deprecated"));
    }

    #[test]
    fn operator_auth_mode_reports_missing_token_disable() {
        let mode = operator_auth_mode_from_env(None, None, None);

        assert_eq!(mode, OperatorAuthMode::MissingTokenDisabled);
        assert!(!mode.enforced());
        assert_eq!(mode.as_str(), "missing-token-disabled");
    }

    #[test]
    fn auth_disabled_is_rejected_for_production_environment() {
        let error = operator_auth_startup_config_error(Some("true"), Some("production"))
            .expect("production should reject auth-disabled mode");

        assert!(error.contains(AUTH_DISABLED_ENV));
        assert!(error.contains(CONTROL_PLANE_ENVIRONMENT_ENV));
        assert!(error.contains("production"));
    }

    #[test]
    fn auth_disabled_is_allowed_for_local_and_uat() {
        assert_eq!(
            operator_auth_startup_config_error(Some("true"), Some("local")),
            None
        );
        assert_eq!(
            operator_auth_startup_config_error(Some("yes"), Some("uat")),
            None
        );
    }

    #[test]
    fn protects_operator_cap_update_route() {
        assert!(requires_operator_auth("POST", "/v1/nodes/contribution-cap"));
    }

    #[test]
    fn protects_operator_policy_override_route() {
        assert!(requires_operator_auth("POST", "/v1/nodes/policy-override"));
    }

    #[test]
    fn protects_single_job_status_route() {
        assert!(requires_operator_auth("GET", "/v1/jobs/job-1"));
    }

    #[test]
    fn request_reader_waits_for_full_content_length_body() {
        let mut reader = ChunkedReader::new(vec![
            b"POST /v1/register HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\n{\"node_id\"",
            b":\"node-1\"}",
        ]);

        let request_text = read_http_request(&mut reader).expect("request");
        let request = parse_request(&request_text);

        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v1/register");
        assert_eq!(request.body, "{\"node_id\":\"node-1\"}");
    }

    #[test]
    fn request_reader_rejects_incomplete_declared_body() {
        let mut reader = ChunkedReader::new(vec![
            b"POST /v1/register HTTP/1.1\r\nContent-Length: 25\r\n\r\n{\"node_id\":\"node-1\"}",
        ]);

        let error = read_http_request(&mut reader).expect_err("incomplete body");

        assert_eq!(
            error,
            HttpRequestReadError::bad_request(
                "request body ended before Content-Length was satisfied"
            )
        );
    }

    #[test]
    fn request_reader_rejects_invalid_content_length() {
        let mut reader = ChunkedReader::new(vec![
            b"POST /v1/register HTTP/1.1\r\nContent-Length: nope\r\n\r\n{}",
        ]);

        let error = read_http_request(&mut reader).expect_err("invalid length");

        assert_eq!(
            error,
            HttpRequestReadError::bad_request("invalid Content-Length")
        );
    }

    #[test]
    fn request_reader_rejects_oversized_declared_body() {
        let request = format!(
            "POST /v1/register HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        let mut reader = ChunkedReader::new(vec![request.as_bytes()]);

        let error = read_http_request(&mut reader).expect_err("oversized");

        assert_eq!(error.status, "413 Payload Too Large");
    }

    #[test]
    fn async_job_payload_exposes_polling_contract() {
        let mut state = ControlPlaneState::default();
        let record = state.submit_job(
            JobRequest {
                request_id: "job-1".to_string(),
                prompt: "summarize this".to_string(),
                preferred_backend: Backend::Auto,
                runtime_mode: RuntimeMode::Local,
                stream: false,
                model: Some("demo".to_string()),
                system_prompt: None,
                max_tokens: None,
                temperature: None,
                top_p: None,
                seed: None,
            },
            "123".to_string(),
        );

        let payload = job_async_payload(&record);

        assert_eq!(payload["job_id"], "job-1");
        assert_eq!(payload["request_id"], "job-1");
        assert_eq!(payload["status"], "queued");
        assert_eq!(payload["status_url"], "/v1/jobs/job-1");
        assert_eq!(payload["polling"]["method"], "GET");
        assert_eq!(payload["polling"]["url"], "/v1/jobs/job-1");
        assert_eq!(payload["polling"]["recommended_interval_seconds"], 2);
        assert_eq!(payload["polling"]["default_timeout_seconds"], 300);
        assert_eq!(payload["job"]["status"], "queued");
        assert_eq!(payload["job"]["output"], serde_json::Value::Null);
        assert_eq!(payload["job"]["error"], serde_json::Value::Null);
    }
}
