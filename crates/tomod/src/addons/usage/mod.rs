//! Provider usage: reads the allowance of each provider, keeps the last result, and warns when a bucket crosses a threshold.
//! It owns no table and no Core state. See docs/usage.md.

use crate::addons;
use crate::daemon::{ok, Daemon, Inner};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tomo_proto::*;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const REQUEST_TIMEOUT_SECS: u64 = 8;
const POLL_INTERVAL_MS: u64 = 5 * 60 * 1000;
const POLL_TICK: Duration = Duration::from_secs(20);
pub const THRESHOLDS: [f64; 2] = [0.80, 0.95];

/// The last result of each provider, in `addons::State`. Memory only: a restart starts empty.
pub type Last = Vec<UsageSnapshot>;

fn unavailable(provider: AgentKind, reason: impl Into<String>, now: u64) -> UsageSnapshot {
    UsageSnapshot { provider, available: false, reason: Some(reason.into()), buckets: Vec::new(), fetched_at_ms: now }
}

fn with_buckets(provider: AgentKind, buckets: Vec<UsageBucket>, now: u64) -> UsageSnapshot {
    if buckets.is_empty() {
        return unavailable(provider, "no usage windows in the response", now);
    }
    UsageSnapshot { provider, available: true, reason: None, buckets, fetched_at_ms: now }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn rfc3339_to_ms(text: &str) -> Option<u64> {
    let (date, rest) = text.split_once('T')?;
    let mut ymd = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (ymd.next()??, ymd.next()??, ymd.next()??);
    let (time, offset_secs) = match rest.strip_suffix('Z') {
        Some(t) => (t, 0),
        None => {
            let idx = rest.rfind(['+', '-'])?;
            let (t, off) = rest.split_at(idx);
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let (oh, om) = off[1..].split_once(':')?;
            (t, sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60))
        }
    };
    let (hms, frac) = time.split_once('.').map_or((time, ""), |(a, b)| (a, b));
    let mut parts = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (h, mi, s) = (parts.next()??, parts.next()??, parts.next()??);
    let millis = format!("{:0<3}", frac.chars().take(3).collect::<String>()).parse::<i64>().unwrap_or(0);
    let secs = days_from_civil(y, m, d) * 86_400 + h * 3600 + mi * 60 + s - offset_secs;
    u64::try_from(secs * 1000 + millis).ok()
}

// ---------------------------------------------------------------- Claude

pub fn parse_claude_token(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(bytes).ok()?.pointer("/claudeAiOauth/accessToken")?.as_str().filter(|s| !s.is_empty()).map(String::from)
}

fn claude_limit_label(limit: &Value) -> (String, Option<String>) {
    let kind = limit.get("kind").and_then(Value::as_str).unwrap_or("limit");
    match kind {
        "session" => ("5-hour".to_string(), None),
        "weekly_all" => ("weekly".to_string(), None),
        "weekly_scoped" => ("weekly".to_string(), Some(limit.pointer("/scope/model/display_name").and_then(Value::as_str).unwrap_or("scoped").to_lowercase())),
        other => (other.replace('_', " "), None),
    }
}

fn claude_window_label(key: &str) -> Option<(String, Option<String>)> {
    match key {
        "five_hour" => Some(("5-hour".to_string(), None)),
        "seven_day" => Some(("weekly".to_string(), None)),
        _ => key.strip_prefix("seven_day_").map(|scope| ("weekly".to_string(), Some(scope.replace('_', " ")))),
    }
}

fn claude_bucket(label: String, scope: Option<String>, percent: Option<f64>, resets_at: Option<&str>, detail: Option<String>) -> UsageBucket {
    UsageBucket { label, fraction_used: percent.map(|p| p / 100.0), resets_at_ms: resets_at.and_then(rfc3339_to_ms), detail, scope }
}

fn claude_buckets(body: &Value) -> Vec<UsageBucket> {
    let from_limits: Vec<UsageBucket> = body
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|limit| {
            let severity = limit.get("severity").and_then(Value::as_str).filter(|s| *s != "normal").map(String::from);
            let (label, scope) = claude_limit_label(limit);
            claude_bucket(label, scope, limit.get("percent").and_then(Value::as_f64), limit.get("resets_at").and_then(Value::as_str), severity)
        })
        .collect();
    if !from_limits.is_empty() {
        return from_limits;
    }
    body.as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, window)| {
            let (label, scope) = claude_window_label(key)?;
            let utilization = window.get("utilization")?.as_f64()?;
            Some(claude_bucket(label, scope, Some(utilization), window.get("resets_at").and_then(Value::as_str), None))
        })
        .collect()
}

pub fn parse_claude(bytes: &[u8], now: u64) -> UsageSnapshot {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(body) => with_buckets(AgentKind::Claude, claude_buckets(&body), now),
        Err(_) => unavailable(AgentKind::Claude, "usage response is not JSON", now),
    }
}

fn claude_token() -> Option<String> {
    let keychain = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_claude_token(&o.stdout));
    keychain.or_else(|| dirs::home_dir().and_then(|h| std::fs::read(h.join(".claude/.credentials.json")).ok()).and_then(|b| parse_claude_token(&b)))
}

pub fn split_status(output: &[u8]) -> (&[u8], &str) {
    let cut = output.iter().rposition(|b| *b == b'\n').unwrap_or(0);
    let status = std::str::from_utf8(&output[cut..]).unwrap_or("").trim();
    (&output[..cut], status)
}

fn fetch_claude(now: u64) -> UsageSnapshot {
    let Some(token) = claude_token() else { return unavailable(AgentKind::Claude, "no Claude login", now) };
    let child = Command::new("curl")
        .args(["-s", "--max-time", &REQUEST_TIMEOUT_SECS.to_string(), "-H", "@-", "-w", "\n%{http_code}", CLAUDE_USAGE_URL])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return unavailable(AgentKind::Claude, format!("curl failed to start: {e}"), now),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("Authorization: Bearer {token}\nanthropic-beta: oauth-2025-04-20\n").as_bytes());
    }
    let Ok(out) = child.wait_with_output() else { return unavailable(AgentKind::Claude, "usage request failed (no response)", now) };
    let (body, status) = split_status(&out.stdout);
    match status {
        "200" => parse_claude(body, now),
        "" | "000" => unavailable(AgentKind::Claude, "usage request failed (no response)", now),
        other => unavailable(AgentKind::Claude, format!("usage request failed ({other})"), now),
    }
}

// ----------------------------------------------------------------- Codex

const CODEX_RATE_LIMITS_ID: u64 = 2;

fn codex_window_label(window: &Value, position: &str) -> String {
    match window.get("windowDurationMins").and_then(Value::as_u64) {
        Some(300) => "5-hour".to_string(),
        Some(10080) => "weekly".to_string(),
        Some(mins) if mins % 1440 == 0 => format!("{}-day", mins / 1440),
        Some(mins) if mins % 60 == 0 => format!("{}-hour", mins / 60),
        Some(mins) => format!("{mins}-minute"),
        None => position.to_string(),
    }
}

fn codex_buckets(result: &Value) -> Vec<UsageBucket> {
    let by_id: Vec<(String, &Value)> = match result.get("rateLimitsByLimitId").and_then(Value::as_object) {
        Some(map) if !map.is_empty() => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        _ => result.get("rateLimits").map(|v| vec![("codex".to_string(), v)]).unwrap_or_default(),
    };
    let several = by_id.len() > 1;
    by_id
        .iter()
        .flat_map(|(id, snapshot)| {
            let name = snapshot.get("limitName").and_then(Value::as_str).map(String::from).unwrap_or_else(|| id.clone());
            let scope = (several && id != "codex").then(|| name.to_lowercase());
            ["primary", "secondary"].into_iter().filter_map(move |position| {
                let window = snapshot.get(position)?;
                let percent = window.get("usedPercent")?.as_f64()?;
                let base = codex_window_label(window, position);
                Some(UsageBucket { label: base, fraction_used: Some(percent / 100.0), resets_at_ms: window.get("resetsAt").and_then(Value::as_u64).map(|s| s * 1000), detail: None, scope: scope.clone() })
            })
        })
        .collect()
}

pub fn parse_codex(bytes: &[u8], now: u64) -> UsageSnapshot {
    let Ok(frame) = serde_json::from_slice::<Value>(bytes) else { return unavailable(AgentKind::Codex, "rate limit response is not JSON", now) };
    if let Some(message) = frame.pointer("/error/message").and_then(Value::as_str) {
        return unavailable(AgentKind::Codex, format!("codex app-server: {message}"), now);
    }
    match frame.get("result") {
        Some(result) => with_buckets(AgentKind::Codex, codex_buckets(result), now),
        None => unavailable(AgentKind::Codex, "rate limit response has no result", now),
    }
}

fn frame_id(line: &str) -> Option<u64> {
    serde_json::from_str::<Value>(line).ok()?.get("id")?.as_u64()
}

fn fetch_codex(now: u64) -> UsageSnapshot {
    let home = dirs::home_dir().unwrap_or_default();
    if !home.join(".codex/auth.json").exists() {
        return unavailable(AgentKind::Codex, "no Codex login", now);
    }
    let child = Command::new("codex").arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return unavailable(AgentKind::Codex, "codex is not installed", now),
        Err(e) => return unavailable(AgentKind::Codex, format!("codex app-server failed to start: {e}"), now),
    };
    let requests = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "tomo", "version": crate::daemon::VERSION } } }),
        json!({ "jsonrpc": "2.0", "method": "initialized" }),
        json!({ "jsonrpc": "2.0", "id": CODEX_RATE_LIMITS_ID, "method": "account/rateLimits/read", "params": { "excludeResetCreditDetails": true } }),
    ];
    let mut stdin = child.stdin.take();
    if let Some(pipe) = stdin.as_mut() {
        let text = requests.iter().map(|r| r.to_string() + "\n").collect::<String>();
        let _ = pipe.write_all(text.as_bytes());
    }
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    let deadline = Instant::now() + Duration::from_secs(REQUEST_TIMEOUT_SECS);
    let answer = loop {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else { break None };
        match rx.recv_timeout(left) {
            Ok(line) if frame_id(&line) == Some(CODEX_RATE_LIMITS_ID) => break Some(line),
            Ok(_) => continue,
            Err(_) => break None,
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    drop(stdin);
    match answer {
        Some(line) => parse_codex(line.as_bytes(), now),
        None => unavailable(AgentKind::Codex, "codex app-server did not answer", now),
    }
}

// ------------------------------------------------------------ all providers

pub fn parse_mock(bytes: &[u8]) -> Result<Vec<UsageSnapshot>, serde_json::Error> {
    serde_json::from_slice(bytes)
}

pub fn fetch_all() -> Vec<UsageSnapshot> {
    let now = now_ms();
    if let Ok(path) = std::env::var("TOMO_USAGE_MOCK") {
        return match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| parse_mock(&b).map_err(|e| e.to_string())) {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("TOMO_USAGE_MOCK {path}: {e}");
                Vec::new()
            }
        };
    }
    vec![fetch_claude(now), fetch_codex(now)]
}

fn same_data(a: &UsageSnapshot, b: &UsageSnapshot) -> bool {
    a.provider == b.provider && a.available == b.available && a.reason == b.reason && a.buckets == b.buckets
}

pub fn same(a: &[UsageSnapshot], b: &[UsageSnapshot]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_data(x, y))
}

fn fraction_of(list: &[UsageSnapshot], provider: AgentKind, bucket: &UsageBucket) -> f64 {
    list.iter()
        .filter(|s| s.provider == provider)
        .flat_map(|s| &s.buckets)
        .find(|b| b.label == bucket.label && b.scope == bucket.scope)
        .and_then(|b| b.fraction_used)
        .unwrap_or(0.0)
}

pub fn crossings(before: &[UsageSnapshot], after: &[UsageSnapshot]) -> Vec<String> {
    after
        .iter()
        .flat_map(|s| s.buckets.iter().map(move |b| (s.provider, b)))
        .filter_map(|(provider, bucket)| {
            let now = bucket.fraction_used?;
            let was = fraction_of(before, provider, bucket);
            let crossed = THRESHOLDS.iter().any(|t| was < *t && now >= *t);
            crossed.then(|| format!("{} {}{} allowance {}%", provider.label(), bucket.scope.as_deref().map(|s| format!("{s} ")).unwrap_or_default(), bucket.label, (now * 100.0).round() as u64))
        })
        .collect()
}

fn newest_fetch_ms(list: &[UsageSnapshot]) -> u64 {
    list.iter().map(|s| s.fetched_at_ms).max().unwrap_or(0)
}

fn due(subscribed: bool, newest_fetch_ms: u64, now: u64) -> bool {
    subscribed && now.saturating_sub(newest_fetch_ms) >= POLL_INTERVAL_MS
}

/// The last result, for the `subscribe` snapshot.
pub fn snapshots(inner: &Inner) -> Vec<UsageSnapshot> {
    addons::state(inner).usage.clone()
}

async fn refresh(daemon: &Arc<Daemon>) {
    let fresh = tokio::task::spawn_blocking(fetch_all).await.unwrap_or_default();
    remember(&mut daemon.lock(), fresh);
}

/// Keeps a new result under the Core lock. It records the diagnostics and emits `usage_changed` and the threshold notices.
pub fn remember(inner: &mut Inner, fresh: Vec<UsageSnapshot>) {
    let before = std::mem::replace(&mut addons::state_mut(inner).usage, fresh.clone());
    for s in &fresh {
        let problem = (!s.available).then(|| s.reason.clone().unwrap_or_else(|| "unavailable".to_string()));
        Daemon::diagnostic_on_change(inner, "usage", &format!("{} usage", s.provider.label().to_lowercase()), problem);
    }
    if !same(&before, &fresh) {
        Daemon::emit(inner, Event::UsageChanged { snapshots: fresh.clone() });
    }
    for message in crossings(&before, &fresh) {
        Daemon::emit(inner, Event::Notice { level: NoticeLevel::Warning, message });
    }
}

/// `usage_get`: fetches at once when `force` is set or when there is no result yet.
pub async fn get(daemon: &Arc<Daemon>, force: bool) -> Result<Value, RpcError> {
    let empty = addons::state(&daemon.lock()).usage.is_empty();
    if force || empty {
        refresh(daemon).await;
    }
    let list = snapshots(&daemon.lock());
    ok(list)
}

/// The background poll. It fetches only while a client is subscribed and the last result is older than five minutes.
pub async fn run(daemon: Arc<Daemon>) {
    loop {
        tokio::time::sleep(POLL_TICK).await;
        let (subscribed, newest) = {
            let inner = daemon.lock();
            (inner.clients.values().any(|c| c.subscribed), newest_fetch_ms(&addons::state(&inner).usage))
        };
        if due(subscribed, newest, now_ms()) {
            refresh(&daemon).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_700_000_000_000;

    fn bucket(label: &str, fraction: f64) -> UsageBucket {
        UsageBucket { label: label.into(), fraction_used: Some(fraction), resets_at_ms: None, detail: None, scope: None }
    }

    fn snapshot(provider: AgentKind, buckets: Vec<UsageBucket>) -> UsageSnapshot {
        UsageSnapshot { provider, available: true, reason: None, buckets, fetched_at_ms: NOW }
    }

    #[test]
    fn rfc3339_with_fraction_and_offset() {
        assert_eq!(rfc3339_to_ms("2026-09-14T23:50:00.661526+00:00"), Some(1_789_429_800_661));
        assert_eq!(rfc3339_to_ms("2026-09-14T23:50:00Z"), Some(1_789_429_800_000));
        assert_eq!(rfc3339_to_ms("2026-09-14T18:50:00-05:00"), Some(1_789_429_800_000));
        assert_eq!(rfc3339_to_ms("not a date"), None);
    }

    #[test]
    fn claude_no_data_is_unavailable() {
        let s = parse_claude(b"{}", NOW);
        assert!(!s.available);
        assert_eq!(s.reason.as_deref(), Some("no usage windows in the response"));
        assert!(s.buckets.is_empty());
        assert_eq!(s.fetched_at_ms, NOW);
    }

    #[test]
    fn claude_one_bucket_from_limits() {
        let body = br#"{"limits":[{"kind":"session","percent":36,"severity":"normal","resets_at":"2026-09-14T23:50:00Z"}]}"#;
        let s = parse_claude(body, NOW);
        assert!(s.available);
        assert_eq!(s.buckets, vec![UsageBucket { label: "5-hour".into(), fraction_used: Some(0.36), resets_at_ms: Some(1_789_429_800_000), detail: None, scope: None }]);
    }

    #[test]
    fn claude_several_buckets_with_scoped_label_and_severity() {
        let body = br#"{"limits":[
            {"kind":"session","percent":36,"severity":"normal","resets_at":"2026-09-14T23:50:00Z"},
            {"kind":"weekly_all","percent":47,"severity":"normal","resets_at":"2026-09-17T14:00:00Z"},
            {"kind":"weekly_scoped","percent":66,"severity":"warning","resets_at":"2026-09-17T14:00:00Z","scope":{"model":{"display_name":"Fable"}}}
        ]}"#;
        let s = parse_claude(body, NOW);
        let labels: Vec<&str> = s.buckets.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, vec!["5-hour", "weekly", "weekly"]);
        assert_eq!(s.buckets.iter().map(|b| b.scope.as_deref()).collect::<Vec<_>>(), vec![None, None, Some("fable")]);
        assert_eq!(s.buckets[2].detail.as_deref(), Some("warning"));
        assert_eq!(s.buckets[1].fraction_used, Some(0.47));
    }

    #[test]
    fn claude_falls_back_to_top_level_windows() {
        let body = br#"{"five_hour":{"utilization":10.0,"resets_at":"2026-09-14T23:50:00Z"},"seven_day":{"utilization":20.0,"resets_at":null},"seven_day_opus":{"utilization":5.0},"nimbus_quill":{"utilization":0.0},"extra_usage":{"is_enabled":false}}"#;
        let s = parse_claude(body, NOW);
        let mut labels: Vec<&str> = s.buckets.iter().map(|b| b.label.as_str()).collect();
        labels.sort();
        assert_eq!(labels, vec!["5-hour", "weekly", "weekly"]);
        assert!(s.buckets.iter().any(|b| b.scope.as_deref() == Some("opus")));
        let weekly = s.buckets.iter().find(|b| b.label == "weekly" && b.scope.is_none()).unwrap();
        assert_eq!(weekly.resets_at_ms, None);
    }

    #[test]
    fn claude_bad_body_is_unavailable() {
        let s = parse_claude(b"<html>", NOW);
        assert!(!s.available);
        assert_eq!(s.reason.as_deref(), Some("usage response is not JSON"));
    }

    #[test]
    fn claude_token_from_credentials_json() {
        assert_eq!(parse_claude_token(br#"{"claudeAiOauth":{"accessToken":"abc"}}"#).as_deref(), Some("abc"));
        assert_eq!(parse_claude_token(br#"{"claudeAiOauth":{"accessToken":""}}"#), None);
        assert_eq!(parse_claude_token(b"nope"), None);
    }

    #[test]
    fn status_splits_off_the_last_line() {
        let (body, status) = split_status(b"{\"a\":1}\n200");
        assert_eq!(body, b"{\"a\":1}");
        assert_eq!(status, "200");
        assert_eq!(split_status(b"").1, "");
    }

    #[test]
    fn codex_two_windows_with_reset_time() {
        let line = br#"{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1789440999},"secondary":{"usedPercent":6,"windowDurationMins":10080,"resetsAt":1789999331}}}}"#;
        let s = parse_codex(line, NOW);
        assert!(s.available);
        assert_eq!(s.buckets.len(), 2);
        assert_eq!(s.buckets[0], UsageBucket { label: "5-hour".into(), fraction_used: Some(0.0), resets_at_ms: Some(1_789_440_999_000), detail: None, scope: None });
        assert_eq!(s.buckets[1].label, "weekly");
        assert_eq!(s.buckets[1].fraction_used, Some(0.06));
    }

    #[test]
    fn codex_several_limit_ids_get_a_scope() {
        let line = br#"{"id":2,"result":{"rateLimits":{},"rateLimitsByLimitId":{
            "codex":{"primary":{"usedPercent":1,"windowDurationMins":300}},
            "other":{"limitName":"Other","primary":{"usedPercent":2,"windowDurationMins":1440}}}}}"#;
        let s = parse_codex(line, NOW);
        let labels: Vec<&str> = s.buckets.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, vec!["5-hour", "1-day"]);
        assert_eq!(s.buckets.iter().map(|b| b.scope.as_deref()).collect::<Vec<_>>(), vec![None, Some("other")]);
    }

    #[test]
    fn codex_error_frame_is_unavailable() {
        let s = parse_codex(br#"{"id":2,"error":{"code":-32000,"message":"not logged in"}}"#, NOW);
        assert!(!s.available);
        assert_eq!(s.reason.as_deref(), Some("codex app-server: not logged in"));
        assert!(!parse_codex(b"garbage", NOW).available);
        assert!(!parse_codex(br#"{"id":2,"result":{}}"#, NOW).available);
    }

    #[test]
    fn mock_file_parses_a_snapshot_list() {
        let text = br#"[{"provider":"claude","available":true,"reason":null,"buckets":[{"label":"5-hour","fraction_used":0.5,"resets_at_ms":1,"detail":null}],"fetched_at_ms":2},
                        {"provider":"codex","available":false,"reason":"no Codex login","buckets":[],"fetched_at_ms":2}]"#;
        let list = parse_mock(text).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].provider, AgentKind::Claude);
        assert!(!list[1].available);
        assert!(parse_mock(b"{}").is_err());
    }

    #[test]
    fn threshold_crossing_fires_once() {
        let before = vec![snapshot(AgentKind::Claude, vec![bucket("weekly", 0.70)])];
        let after = vec![snapshot(AgentKind::Claude, vec![bucket("weekly", 0.83)])];
        assert_eq!(crossings(&before, &after), vec!["Claude weekly allowance 83%"]);
        assert!(crossings(&after, &after).is_empty());
        let higher = vec![snapshot(AgentKind::Claude, vec![bucket("weekly", 0.96)])];
        assert_eq!(crossings(&after, &higher), vec!["Claude weekly allowance 96%"]);
        assert!(crossings(&higher, &after).is_empty());
    }

    #[test]
    fn first_sight_above_threshold_fires_and_unknown_fraction_is_silent() {
        let after = vec![snapshot(AgentKind::Codex, vec![bucket("5-hour", 0.90), UsageBucket { label: "weekly".into(), fraction_used: None, resets_at_ms: None, detail: None, scope: None }])];
        assert_eq!(crossings(&[], &after), vec!["Codex 5-hour allowance 90%"]);
    }

    #[test]
    fn polls_only_with_a_subscriber_and_a_stale_result() {
        let stale = NOW - POLL_INTERVAL_MS;
        assert!(due(true, stale, NOW));
        assert!(due(true, 0, NOW));
        assert!(!due(false, stale, NOW));
        assert!(!due(true, stale + 1, NOW));
    }

    #[test]
    fn same_ignores_fetch_time_and_sees_a_provider_change() {
        let a = vec![snapshot(AgentKind::Claude, vec![bucket("weekly", 0.5)])];
        let mut b = a.clone();
        b[0].fetched_at_ms += 1;
        assert!(same(&a, &b));
        let unavailable_now = vec![unavailable(AgentKind::Claude, "no Claude login", NOW)];
        assert!(!same(&a, &unavailable_now));
    }
}
