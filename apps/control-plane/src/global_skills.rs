use std::collections::BTreeMap;
use std::time::Duration;
use serde_json::{json, Value};

pub fn page() -> String { include_str!("global_skills.html").to_string() }

pub fn response(method: &str, body: &str, headers: &BTreeMap<String, String>) -> String {
    let email = crate::admin_login::session_email(headers);
    let input = if method == "PUT" {
        if email.is_none() || !crate::admin_login::session_authorized(method, headers) {
            return reply("403 Forbidden", json!({"error":"Sign in as a control-plane administrator to edit global skills."}));
        }
        match serde_json::from_str::<Value>(body) {
            Ok(Value::Object(mut input)) => {
                // Never trust a caller-supplied audit identity.
                input.insert("actor".into(), json!(email));
                Some(Value::Object(input))
            }
            _ => return reply("400 Bad Request", json!({"error":"A skill update object is required."})),
        }
    } else { None };
    match forward(method, input) {
        Ok(mut value) => {
            if method == "GET" {
                redact_catalog(&mut value, email.is_some());
            }
            reply("200 OK", value)
        }
        Err((status, message)) => reply(status, json!({"error":message})),
    }
}

fn redact_catalog(value: &mut Value, admin: bool) {
    if !admin {
        if let Some(skills) = value.get_mut("system").and_then(Value::as_array_mut) {
            for skill in skills { if let Some(record) = skill.as_object_mut() { record.remove("content"); } }
        }
    }
    value["permissions"] = json!({"edit_global":admin});
}

fn forward(method: &str, input: Option<Value>) -> Result<Value, (&'static str, String)> {
    let origin = std::env::var("MUNDUSX_ADMIN_CHAT_ORIGIN").unwrap_or_else(|_| "https://chat.mundusx.ai".into());
    let token = std::env::var("MUNDUSX_OPERATOR_TOKEN").unwrap_or_default();
    if !origin.starts_with("https://") || token.trim().len() < 32 {
        return Err(("503 Service Unavailable", "Global skill storage is not configured.".into()));
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).build();
    let url = format!("{}/internal/control-plane/skills", origin.trim_end_matches('/'));
    let request = agent.request(method, &url).set("Authorization", &format!("Bearer {}", token.trim()));
    let result = if let Some(input) = input { request.send_json(input) } else { request.call() };
    match result {
        Ok(response) => response.into_json().map_err(|_| ("502 Bad Gateway", "Skill storage returned an invalid response.".into())),
        Err(ureq::Error::Status(status, response)) if matches!(status, 400 | 403 | 404) => {
            let value: Value = response.into_json().unwrap_or_default();
            let message = value.get("error").and_then(Value::as_str).unwrap_or("Skill update failed.").to_string();
            Err((match status { 400 => "400 Bad Request", 403 => "403 Forbidden", _ => "404 Not Found" }, message))
        }
        Err(_) => Err(("503 Service Unavailable", "Global skills could not be loaded from storage. Please retry.".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_catalog_contains_metadata_but_never_instructions() {
        let mut catalog = json!({"system":[{"id":"router","content":"private instructions","enabled":true}]});
        redact_catalog(&mut catalog, false);
        assert!(catalog["system"][0].get("content").is_none());
        assert_eq!(catalog["system"][0]["enabled"], true);
        assert_eq!(catalog["permissions"]["edit_global"], false);
    }
    #[test]
    fn administrator_catalog_preserves_real_markdown() {
        let mut catalog = json!({"system":[{"id":"router","content":"# Router\nChoose tools."}]});
        redact_catalog(&mut catalog, true);
        assert_eq!(catalog["system"][0]["content"], "# Router\nChoose tools.");
        assert_eq!(catalog["permissions"]["edit_global"], true);
    }
    #[test]
    fn writes_require_an_admin_session_before_contacting_storage() {
        let result = response("PUT", r#"{"id":"router","actor":"forged@example.com"}"#, &BTreeMap::new());
        assert!(result.starts_with("HTTP/1.1 403"));
    }
}

fn reply(status: &str, body: Value) -> String {
    crate::json_response(status, body).replacen("Content-Type:", "Cache-Control: no-store\r\nVary: Cookie\r\nContent-Type:", 1)
}
