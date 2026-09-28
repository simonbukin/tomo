//! Pure rules of the Linear addon: which issue a branch names, the one query for all of them, and how to read the answer.

use serde_json::{json, Value};
use tomo_proto::{Id, LinearIssue, LinearLink, LinearState, LinearStatus, LinearViewer};

pub const POLL_INTERVAL_MS: u64 = 60_000;

const ISSUES_QUERY: &str = "query($filter: IssueFilter!, $first: Int!) { issues(filter: $filter, first: $first, includeArchived: true) { nodes { identifier title url priorityLabel state { name type color } assignee { name } } } }";
pub const VIEWER_QUERY: &str = "query { viewer { name } }";

/// A key goes to `security -i` inside a command line, so it may hold only the characters of a Linear personal key.
pub fn valid_key(key: &str) -> bool {
    key.strip_prefix("lin_api_").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// The first `TEAM-123` in a branch, with the team key in upper case: `simon/eng-2611-fix` gives `ENG-2611`.
pub fn identifier(branch: &str) -> Option<(String, u32)> {
    branch.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).find_map(|segment| {
        let parts: Vec<&str> = segment.split('-').collect();
        parts.windows(2).find_map(|w| {
            let key_like = w[0].starts_with(|c: char| c.is_ascii_alphabetic());
            let number = w[1].parse::<u32>().ok().filter(|_| w[1].chars().all(|c| c.is_ascii_digit()));
            key_like.then_some(number).flatten().map(|n| (w[0].to_ascii_uppercase(), n))
        })
    })
}

/// A worktree and the issue that its branch names.
pub type Wanted = (Id, (String, u32));

pub fn identifier_text((team, number): &(String, u32)) -> String {
    format!("{team}-{number}")
}

/// Each worktree whose branch names an issue, with that issue's identifier.
pub fn wanted<'a>(branches: impl Iterator<Item = (&'a Id, &'a str)>) -> Vec<Wanted> {
    branches.filter_map(|(id, branch)| identifier(branch).map(|ident| (id.clone(), ident))).collect()
}

/// Each branch of the `or` needs an explicit `and`: Linear matches almost every issue for `{ team, number }` inside an `or`.
pub fn issues_request(wanted: &[Wanted]) -> Value {
    let or: Vec<Value> = wanted.iter().map(|(_, (team, number))| json!({ "and": [{ "team": { "key": { "eq": team } } }, { "number": { "eq": number } }] })).collect();
    // ponytail: one page of at most 250 issues (Linear's page cap); page with `after` if one daemon ever links more.
    json!({ "query": ISSUES_QUERY, "variables": { "filter": { "or": or }, "first": wanted.len().min(250) } })
}

pub fn viewer_request() -> Value {
    json!({ "query": VIEWER_QUERY })
}

/// The reason in a GraphQL answer that has `errors`, or in an HTTP status that is not 200.
pub fn failure(status: &str, body: &Value) -> Option<String> {
    let first = body["errors"].get(0);
    let code = first.and_then(|e| e["extensions"]["code"].as_str());
    match (status, code) {
        ("" | "000", _) => Some("Linear did not answer".to_string()),
        ("401", _) | (_, Some("AUTHENTICATION_ERROR")) => Some("Linear rejected the key; run `tomo linear login` again".to_string()),
        ("429", _) | (_, Some("RATELIMITED")) => Some("Linear rate limit reached".to_string()),
        ("200", _) if first.is_none() && body["data"].is_object() => None,
        ("200", _) if first.is_none() => Some("Linear gave an answer without data".to_string()),
        _ => Some(first.and_then(|e| e["message"].as_str()).map_or_else(|| format!("Linear answered {status}"), |m| format!("Linear: {m}"))),
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// The colour goes into a style and the url goes to the opener, so each must have the one shape that Linear sends.
fn hex_color(v: &Value) -> String {
    v.as_str().filter(|c| c.len() <= 9 && c.strip_prefix('#').is_some_and(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit()))).unwrap_or_default().to_string()
}

fn issue(n: &Value) -> Option<LinearIssue> {
    let state = LinearState { name: text(&n["state"]["name"])?, kind: text(&n["state"]["type"])?, color: hex_color(&n["state"]["color"]) };
    let url = text(&n["url"]).filter(|u| u.starts_with("https://linear.app/"))?;
    Some(LinearIssue { identifier: text(&n["identifier"])?, title: text(&n["title"])?, url, state, assignee: text(&n["assignee"]["name"]), priority: text(&n["priorityLabel"])? })
}

pub fn links(wanted: &[Wanted], body: &Value) -> Vec<LinearLink> {
    let issues: Vec<LinearIssue> = body["data"]["issues"]["nodes"].as_array().into_iter().flatten().filter_map(issue).collect();
    wanted
        .iter()
        .filter_map(|(worktree_id, ident)| {
            let text = identifier_text(ident);
            issues.iter().find(|i| i.identifier == text).map(|issue| LinearLink { worktree_id: worktree_id.clone(), issue: issue.clone() })
        })
        .collect()
}

pub fn viewer(body: &Value) -> Option<LinearViewer> {
    serde_json::from_value(body["data"]["viewer"].clone()).ok()
}

pub fn unavailable(reason: impl Into<String>, now: u64) -> LinearStatus {
    LinearStatus { available: false, reason: Some(reason.into()), links: vec![], fetched_at_ms: now }
}

pub fn found(links: Vec<LinearLink>, now: u64) -> LinearStatus {
    LinearStatus { available: true, reason: None, links, fetched_at_ms: now }
}

/// A fetch is due while a client watches, when the last one is old or when a branch names another issue since it.
pub fn due(subscribed: bool, last: &LinearStatus, asked: &[Wanted], wanted_now: &[Wanted], now: u64) -> bool {
    subscribed && (stale(last, now) || asked != wanted_now)
}

/// A fetch that started before the kept answer, such as a poll that was in flight during a logout, must not replace it.
/// Fetches are numbered, not timed, so a clock set back cannot freeze the answer.
pub fn newer(kept: u64, fetch: u64) -> bool {
    fetch > kept
}

/// An answer that is old enough that a caller must not read it as the current state. An answer from the future means the clock went back, so it is stale too.
pub fn stale(last: &LinearStatus, now: u64) -> bool {
    now < last.fetched_at_ms || now - last.fetched_at_ms >= POLL_INTERVAL_MS
}

pub fn same(a: &LinearStatus, b: &LinearStatus) -> bool {
    a.available == b.available && a.reason == b.reason && a.links == b.links
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ident(s: &str) -> Option<String> {
        identifier(s).map(|i| identifier_text(&i))
    }

    #[test]
    fn identifier_from_linear_branch_names() {
        assert_eq!(ident("eng-2611-fix-login"), Some("ENG-2611".into()));
        assert_eq!(ident("simon/eng-2611-fix-login"), Some("ENG-2611".into()));
        assert_eq!(ident("feature/ENG-4-x"), Some("ENG-4".into()));
        assert_eq!(ident("fix-eng-12"), Some("ENG-12".into()));
        assert_eq!(ident("eng-12_and-more"), Some("ENG-12".into()));
    }

    #[test]
    fn identifier_needs_a_key_then_a_number() {
        assert_eq!(ident("main"), None);
        assert_eq!(ident("eng-"), None);
        assert_eq!(ident("2611-fix"), None);
        assert_eq!(ident("eng-26x"), None);
        assert_eq!(ident("eng-99999999999"), None);
        assert_eq!(ident("-12"), None);
    }

    #[test]
    fn identifier_takes_the_first_of_two() {
        assert_eq!(ident("eng-1-and-eng-2"), Some("ENG-1".into()));
    }

    #[test]
    fn key_shape() {
        assert!(valid_key("lin_api_abcDEF123"));
        assert!(!valid_key("lin_api_"));
        assert!(!valid_key("lin_api_abc -w x"));
        assert!(!valid_key("lin_api_abc\ndelete-keychain"));
        assert!(!valid_key("lin_oauth_abc"));
    }

    #[test]
    fn request_has_one_filter_per_worktree() {
        let wanted = vec![("w1".to_string(), ("ENG".to_string(), 1)), ("w2".to_string(), ("ENG".to_string(), 2))];
        let r = issues_request(&wanted);
        assert_eq!(r["variables"]["filter"]["or"][1], json!({ "and": [{ "team": { "key": { "eq": "ENG" } } }, { "number": { "eq": 2 } }] }));
        assert_eq!(r["variables"]["first"], 2);
    }

    fn node(identifier: &str) -> Value {
        json!({ "identifier": identifier, "title": "Fix it", "url": "https://linear.app/x/issue/ENG-1", "priorityLabel": "High", "state": { "name": "In Progress", "type": "started", "color": "#f2c94c" }, "assignee": null })
    }

    #[test]
    fn links_match_worktrees_and_skip_missing_issues() {
        let wanted = vec![("w1".to_string(), ("ENG".to_string(), 1)), ("w2".to_string(), ("ENG".to_string(), 404))];
        let body = json!({ "data": { "issues": { "nodes": [node("ENG-1"), { "broken": true }] } } });
        let got = links(&wanted, &body);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].worktree_id, "w1");
        assert_eq!(got[0].issue.state.kind, "started");
        assert_eq!(got[0].issue.priority, "High");
        assert_eq!(got[0].issue.assignee, None);
    }

    #[test]
    fn links_refuse_a_color_or_url_of_another_shape() {
        let wanted = vec![("w1".to_string(), ("ENG".to_string(), 1))];
        let mut odd = node("ENG-1");
        odd["state"]["color"] = json!("red; background: url(x)");
        assert_eq!(links(&wanted, &json!({ "data": { "issues": { "nodes": [odd] } } }))[0].issue.state.color, "");
        let mut elsewhere = node("ENG-1");
        elsewhere["url"] = json!("file:///etc/passwd");
        assert!(links(&wanted, &json!({ "data": { "issues": { "nodes": [elsewhere] } } })).is_empty());
    }

    #[test]
    fn an_older_fetch_does_not_replace_a_newer_answer() {
        assert!(!newer(2, 1));
        assert!(!newer(2, 2));
        assert!(newer(2, 3));
        assert!(stale(&found(vec![], 0), POLL_INTERVAL_MS));
        assert!(!stale(&found(vec![], 1), POLL_INTERVAL_MS));
        assert!(stale(&found(vec![], 5_000), 1_000));
    }

    #[test]
    fn failure_reasons() {
        assert_eq!(failure("200", &json!({ "data": {} })), None);
        assert_eq!(failure("200", &json!(null)), Some("Linear gave an answer without data".into()));
        assert!(failure("401", &json!({})).unwrap().contains("rejected"));
        assert!(failure("400", &json!({ "errors": [{ "message": "x", "extensions": { "code": "RATELIMITED" } }] })).unwrap().contains("rate limit"));
        assert!(failure("200", &json!({ "errors": [{ "message": "Authentication required", "extensions": { "code": "AUTHENTICATION_ERROR" } }] })).unwrap().contains("rejected"));
        assert_eq!(failure("200", &json!({ "errors": [{ "message": "bad filter" }] })), Some("Linear: bad filter".into()));
        assert_eq!(failure("000", &json!(null)), Some("Linear did not answer".into()));
        assert_eq!(failure("502", &json!(null)), Some("Linear answered 502".into()));
    }

    #[test]
    fn due_on_age_or_new_branches_only_while_watched() {
        let last = found(vec![], 1_000);
        let a = vec![("w1".to_string(), ("ENG".to_string(), 1))];
        let renamed = vec![("w1".to_string(), ("ENG".to_string(), 2))];
        assert!(!due(false, &last, &a, &[], 1_000_000));
        assert!(!due(true, &last, &a, &a, 1_000 + POLL_INTERVAL_MS - 1));
        assert!(due(true, &last, &a, &a, 1_000 + POLL_INTERVAL_MS));
        assert!(due(true, &last, &a, &[], 1_001));
        assert!(due(true, &last, &a, &renamed, 1_001));
    }
}
