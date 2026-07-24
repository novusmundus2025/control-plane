use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

const PLANNER_URL_ENV: &str = "MUNDUSX_PLANNER_URL";
const PLANNER_TIMEOUT_MS_ENV: &str = "MUNDUSX_PLANNER_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS: u64 = 1500;

#[derive(Clone, Debug, Eq, PartialEq)]
struct PlannerUrl {
    scheme: UrlScheme,
    host: String,
    port: u16,
    path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum UrlScheme {
    Http,
    Https,
}

#[derive(Clone, Debug)]
struct PlannerProbeConfig {
    url: String,
    timeout: Duration,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlannerServiceStatus {
    pub enabled: bool,
    pub url_configured: bool,
    pub url: Option<String>,
    pub reachable: bool,
    pub provider: String,
    pub status: String,
    pub fallback_mode: bool,
    pub latency_ms: Option<u128>,
    pub last_error: Option<String>,
}

impl PlannerProbeConfig {
    fn from_env() -> Option<Self> {
        let url = std::env::var(PLANNER_URL_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        let timeout_ms = std::env::var(PLANNER_TIMEOUT_MS_ENV)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        Some(Self {
            url,
            timeout: Duration::from_millis(timeout_ms),
        })
    }
}

pub fn planner_service_status_from_env() -> PlannerServiceStatus {
    let Some(config) = PlannerProbeConfig::from_env() else {
        return PlannerServiceStatus {
            enabled: false,
            url_configured: false,
            url: None,
            reachable: false,
            provider: "rust".to_string(),
            status: "disabled".to_string(),
            fallback_mode: true,
            latency_ms: None,
            last_error: None,
        };
    };

    let started = Instant::now();
    match probe_http_url(&config.url, config.timeout) {
        Ok(()) => PlannerServiceStatus {
            enabled: true,
            url_configured: true,
            url: Some(config.url),
            reachable: true,
            provider: "planner-service".to_string(),
            status: "ready".to_string(),
            fallback_mode: false,
            latency_ms: Some(started.elapsed().as_millis()),
            last_error: None,
        },
        Err(error) => PlannerServiceStatus {
            enabled: true,
            url_configured: true,
            url: Some(config.url),
            reachable: false,
            provider: "rust".to_string(),
            status: "degraded".to_string(),
            fallback_mode: true,
            latency_ms: Some(started.elapsed().as_millis()),
            last_error: Some(error),
        },
    }
}

fn probe_http_url(url: &str, timeout: Duration) -> Result<(), String> {
    let parsed = parse_planner_url(url)?;
    let stream = TcpStream::connect((parsed.host.as_str(), parsed.port))
        .map_err(|error| format!("planner_connect_failed: {error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("planner_read_timeout_setup_failed: {error}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("planner_write_timeout_setup_failed: {error}"))?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        parsed.path, parsed.host
    );
    let read = match parsed.scheme {
        UrlScheme::Http => probe_stream(stream, request.as_bytes()),
        UrlScheme::Https => {
            let connector = native_tls::TlsConnector::new()
                .map_err(|error| format!("planner_tls_setup_failed: {error}"))?;
            let tls_stream = connector
                .connect(parsed.host.as_str(), stream)
                .map_err(|error| format!("planner_tls_connect_failed: {error}"))?;
            probe_stream(tls_stream, request.as_bytes())
        }
    }?;
    if read == 0 {
        return Err("planner_empty_response".to_string());
    }
    Ok(())
}

fn probe_stream<S: Read + Write>(mut stream: S, request: &[u8]) -> Result<usize, String> {
    stream
        .write_all(request)
        .map_err(|error| format!("planner_write_failed: {error}"))?;

    let mut buffer = [0_u8; 16];
    stream
        .read(&mut buffer)
        .map_err(|error| format!("planner_read_failed: {error}"))
}

fn parse_planner_url(url: &str) -> Result<PlannerUrl, String> {
    let (scheme, rest, default_port) = if let Some(rest) = url.strip_prefix("http://") {
        (UrlScheme::Http, rest, 80)
    } else if let Some(rest) = url.strip_prefix("https://") {
        (UrlScheme::Https, rest, 443)
    } else {
        return Err("planner_url_must_use_http_or_https".to_string());
    };
    let (authority, path) = rest
        .split_once('/')
        .map(|(authority, path)| (authority, format!("/{path}")))
        .unwrap_or((rest, "/".to_string()));
    let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
        let parsed_port = port
            .parse::<u16>()
            .map_err(|_| "planner_url_invalid_port".to_string())?;
        (host.to_string(), parsed_port)
    } else {
        (authority.to_string(), default_port)
    };
    if host.trim().is_empty() {
        return Err("planner_url_missing_host".to_string());
    }
    Ok(PlannerUrl {
        scheme,
        host,
        port,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn planner_status_reports_disabled_without_url() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::remove_var(PLANNER_URL_ENV);
        std::env::remove_var(PLANNER_TIMEOUT_MS_ENV);

        let status = planner_service_status_from_env();

        assert!(!status.enabled);
        assert!(!status.url_configured);
        assert_eq!(status.status, "disabled");
        assert_eq!(status.provider, "rust");
        assert!(status.fallback_mode);
    }

    #[test]
    fn planner_status_reports_degraded_when_configured_service_is_down() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var(PLANNER_URL_ENV, "http://127.0.0.1:1/v1/plan");
        std::env::set_var(PLANNER_TIMEOUT_MS_ENV, "5");

        let status = planner_service_status_from_env();

        std::env::remove_var(PLANNER_URL_ENV);
        std::env::remove_var(PLANNER_TIMEOUT_MS_ENV);

        assert!(status.enabled);
        assert!(status.url_configured);
        assert!(!status.reachable);
        assert_eq!(status.status, "degraded");
        assert_eq!(status.provider, "rust");
        assert!(status.fallback_mode);
        assert!(status.last_error.is_some());
    }

    #[test]
    fn parses_http_url_with_default_path() {
        let parsed = parse_planner_url("http://127.0.0.1:8091").expect("parse url");

        assert_eq!(
            parsed,
            PlannerUrl {
                scheme: UrlScheme::Http,
                host: "127.0.0.1".to_string(),
                port: 8091,
                path: "/".to_string(),
            }
        );
    }

    #[test]
    fn parses_https_url_with_default_port() {
        let parsed =
            parse_planner_url("https://planner.railway.internal/v1/plan").expect("parse url");

        assert_eq!(
            parsed,
            PlannerUrl {
                scheme: UrlScheme::Https,
                host: "planner.railway.internal".to_string(),
                port: 443,
                path: "/v1/plan".to_string(),
            }
        );
    }
}
