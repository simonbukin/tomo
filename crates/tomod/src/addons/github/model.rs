use crate::activity;
use serde_json::{json, Value};
use std::process::Output;
use tomo_proto::{now_ms, ActivityEvent, ActivityKind, GitHubActivity, PrStatusResult, PullRequest};

/// How long a fetched pull request answers `pr_status` without a new `gh` run.
pub const FRESH_MS: u64 = 60_000;

pub fn parse_pr(v: &Value) -> Option<PullRequest> {
    let number = v.get("number")?.as_u64()?;
    let (mut passed, mut failed, mut pending) = (0u32, 0u32, 0u32);
    for check in v.get("statusCheckRollup").and_then(Value::as_array).into_iter().flatten() {
        let conclusion = check.get("conclusion").and_then(Value::as_str).unwrap_or("");
        let status = check.get("status").and_then(Value::as_str).unwrap_or("");
        let state = check.get("state").and_then(Value::as_str).unwrap_or("");
        match (conclusion, status, state) {
            ("SUCCESS", _, _) | ("NEUTRAL", _, _) | ("SKIPPED", _, _) | (_, _, "SUCCESS") => passed += 1,
            ("FAILURE", _, _) | ("CANCELLED", _, _) | ("TIMED_OUT", _, _) | ("ACTION_REQUIRED", _, _) | (_, _, "FAILURE") | (_, _, "ERROR") => failed += 1,
            _ => pending += 1,
        }
    }
    Some(PullRequest {
        number,
        title: v.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
        url: v.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
        state: v.get("state").and_then(Value::as_str).unwrap_or("").to_lowercase(),
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        review_decision: v.get("reviewDecision").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| s.to_lowercase()),
        mergeable: v.get("mergeable").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| s.to_lowercase()),
        checks_passed: passed,
        checks_failed: failed,
        checks_pending: pending,
        fetched_at_ms: now_ms(),
    })
}

fn unavailable(reason: impl Into<String>) -> PrStatusResult {
    PrStatusResult { available: false, reason: Some(reason.into()), pr: None }
}

/// The `pr_status` answer for the outcome of `gh pr view`.
pub fn answer(out: std::io::Result<Output>) -> PrStatusResult {
    match out {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => unavailable("gh is not installed"),
        Err(e) => unavailable(e.to_string()),
        Ok(o) if o.status.success() => {
            PrStatusResult { available: true, reason: None, pr: parse_pr(&serde_json::from_slice(&o.stdout).unwrap_or(Value::Null)) }
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if err.contains("no pull requests found") {
                PrStatusResult { available: true, reason: None, pr: None }
            } else {
                unavailable(err.lines().next().unwrap_or("gh failed"))
            }
        }
    }
}

/// A cached pull request younger than `FRESH_MS` answers without `gh`. An answer without a pull request is never fresh.
pub fn fresh(cached: Option<&PrStatusResult>, now_ms: u64) -> bool {
    cached.and_then(|c| c.pr.as_ref()).is_some_and(|pr| now_ms.saturating_sub(pr.fetched_at_ms) < FRESH_MS)
}

/// What a new answer means next to the answer that it replaces.
#[derive(Debug, PartialEq)]
pub struct Update<'a> {
    /// The pull request differs, so `pr_changed` fires. A new fetch of the same pull request differs by `fetched_at_ms`.
    pub changed: bool,
    /// The pull request is merged now and was not merged before, so `pr_merged` is recorded.
    pub merged: Option<&'a PullRequest>,
}

pub fn update<'a>(before: Option<&PrStatusResult>, after: &'a PrStatusResult) -> Update<'a> {
    let was_merged = before.and_then(|b| b.pr.as_ref()).is_some_and(|pr| pr.state == "merged");
    Update { changed: before.map(|b| &b.pr) != Some(&after.pr), merged: after.pr.as_ref().filter(|pr| pr.state == "merged" && !was_merged) }
}

pub fn merged_event(worktree_id: &str, pr: &PullRequest) -> ActivityEvent {
    ActivityEvent {
        detail: Some(pr.title.clone()),
        payload: json!({ "number": pr.number, "url": pr.url }),
        ..activity::event(GitHubActivity::PrMerged, Some(worktree_id), format!("PR #{} merged", pr.number))
    }
}

/// The tags that GitHub owns. A worktree carries at most one of them, and only this addon sets them.
pub const PR_TAGS: [&str; 6] = ["draft", "review", "changes-requested", "approved", "merged", "closed"];

pub fn pr_tag(pr: &PullRequest) -> &'static str {
    match (pr.state.as_str(), pr.draft, pr.review_decision.as_deref()) {
        ("merged", _, _) => "merged",
        ("closed", _, _) => "closed",
        (_, true, _) => "draft",
        (_, _, Some("changes_requested")) => "changes-requested",
        (_, _, Some("approved")) => "approved",
        _ => "review",
    }
}

/// The user's tags with the one GitHub tag that fits the pull request in place of any other.
pub fn with_pr_tag(tags: &[String], pr: &PullRequest) -> Vec<String> {
    let tag = pr_tag(pr);
    tags.iter().filter(|t| t.as_str() == tag || !PR_TAGS.contains(&t.as_str())).cloned().chain((!tags.iter().any(|t| t == tag)).then(|| tag.to_string())).collect()
}

/// A pull request link: the number, the URL, and the state.
#[derive(Debug, PartialEq)]
pub struct KnownPr {
    pub number: u64,
    pub url: String,
    pub state: String,
}

/// The cached pull request, or else the newest `pr_merged` event in `events`.
pub fn known_pr(cached: Option<&PrStatusResult>, events: &[ActivityEvent]) -> Option<KnownPr> {
    let merged: ActivityKind = GitHubActivity::PrMerged.into();
    cached.and_then(|c| c.pr.as_ref()).map(|p| KnownPr { number: p.number, url: p.url.clone(), state: p.state.clone() }).or_else(|| {
        let e = events.iter().filter(|e| e.kind == merged).max_by_key(|e| e.occurred_at_ms)?;
        let url = e.payload.get("url")?.as_str().filter(|s| !s.is_empty())?.to_string();
        Some(KnownPr { number: e.payload.get("number")?.as_u64()?, url, state: "merged".into() })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;
    use tomo_proto::CoreActivity;

    fn pr(state: &str, fetched_at_ms: u64) -> PullRequest {
        PullRequest {
            number: 3,
            title: "t".into(),
            url: "u".into(),
            state: state.into(),
            draft: false,
            review_decision: None,
            mergeable: None,
            checks_passed: 0,
            checks_failed: 0,
            checks_pending: 0,
            fetched_at_ms,
        }
    }

    fn found(pr: Option<PullRequest>) -> PrStatusResult {
        PrStatusResult { available: true, reason: None, pr }
    }

    fn gh(code: i32, stdout: &str, stderr: &str) -> std::io::Result<Output> {
        Ok(Output { status: ExitStatus::from_raw(code << 8), stdout: stdout.into(), stderr: stderr.into() })
    }

    fn event(kind: impl Into<ActivityKind>, at: u64, payload: Value) -> ActivityEvent {
        ActivityEvent {
            id: format!("e{at}"),
            kind: kind.into(),
            occurred_at_ms: at,
            worktree_id: Some("w1".into()),
            pane_id: None,
            agent_kind: None,
            title: String::new(),
            detail: None,
            payload,
            attention_id: None,
        }
    }

    #[test]
    fn parses_checks_from_both_rollup_shapes() {
        let v = serde_json::json!({
            "number": 12, "title": "x", "url": "u", "state": "OPEN", "isDraft": false, "reviewDecision": "APPROVED", "mergeable": "MERGEABLE",
            "statusCheckRollup": [
                {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": ""},
                {"__typename": "StatusContext", "state": "FAILURE"}
            ]
        });
        let pr = parse_pr(&v).unwrap();
        assert_eq!((pr.checks_passed, pr.checks_failed, pr.checks_pending), (1, 1, 1));
        assert_eq!(pr.review_decision.as_deref(), Some("approved"));
        assert_eq!(pr.state, "open");
    }

    #[test]
    fn answers_every_gh_outcome() {
        let missing = answer(Err(std::io::Error::from(std::io::ErrorKind::NotFound)));
        assert_eq!((missing.available, missing.reason.as_deref()), (false, Some("gh is not installed")));
        assert_eq!(answer(Err(std::io::Error::other("boom"))).reason.as_deref(), Some("boom"));
        let open = answer(gh(0, r#"{"number":5,"state":"OPEN"}"#, ""));
        assert_eq!((open.available, open.pr.map(|p| (p.number, p.state))), (true, Some((5, "open".to_string()))));
        let garbage = answer(gh(0, "not json", ""));
        assert_eq!((garbage.available, garbage.reason, garbage.pr), (true, None, None));
        let none = answer(gh(1, "", "no pull requests found for branch \"x\"\n"));
        assert_eq!((none.available, none.reason, none.pr), (true, None, None));
        assert_eq!(answer(gh(1, "", "  gh: auth required\nrun gh auth login\n")).reason.as_deref(), Some("gh: auth required"));
        assert_eq!(answer(gh(4, "", "")).reason.as_deref(), Some("gh failed"));
    }

    #[test]
    fn only_a_pull_request_younger_than_a_minute_is_fresh() {
        assert!(!fresh(None, 100));
        assert!(!fresh(Some(&found(None)), 100));
        assert!(fresh(Some(&found(Some(pr("open", 1_000)))), 60_999));
        assert!(!fresh(Some(&found(Some(pr("open", 1_000)))), 61_000));
    }

    #[test]
    fn an_answer_changes_when_the_pull_request_differs_and_merges_once() {
        let open = found(Some(pr("open", 1)));
        let merged = found(Some(pr("merged", 2)));
        assert_eq!(update(None, &found(None)), Update { changed: true, merged: None });
        assert_eq!(update(Some(&found(None)), &found(None)), Update { changed: false, merged: None });
        assert_eq!(update(Some(&open), &open), Update { changed: false, merged: None });
        assert_eq!(update(Some(&open), &found(Some(pr("open", 9)))), Update { changed: true, merged: None });
        assert_eq!(update(Some(&open), &merged).merged.map(|p| p.fetched_at_ms), Some(2));
        assert_eq!(update(None, &merged).merged.map(|p| p.fetched_at_ms), Some(2));
        assert_eq!(update(Some(&merged), &found(Some(pr("merged", 3)))), Update { changed: true, merged: None });
    }

    #[test]
    fn the_merge_event_names_the_pull_request() {
        let e = merged_event("w1", &PullRequest { number: 7, title: "Ship it".into(), url: "https://github.com/o/r/pull/7".into(), ..pr("merged", 1) });
        assert_eq!(
            (e.kind.as_str(), e.worktree_id.as_deref(), e.title.as_str(), e.detail.as_deref()),
            ("pr_merged", Some("w1"), "PR #7 merged", Some("Ship it"))
        );
        assert_eq!(e.payload, json!({ "number": 7, "url": "https://github.com/o/r/pull/7" }));
    }

    #[test]
    fn a_cached_pull_request_wins_over_the_newest_merge_event() {
        let events = [
            event(GitHubActivity::PrMerged, 70, json!({ "number": 12, "url": "https://github.com/o/r/pull/12" })),
            event(GitHubActivity::PrMerged, 20, json!({ "number": 11, "url": "https://github.com/o/r/pull/11" })),
            event(CoreActivity::Archived, 90, json!({ "number": 99, "url": "x" })),
        ];
        assert_eq!(known_pr(Some(&found(Some(pr("open", 1)))), &events), Some(KnownPr { number: 3, url: "u".into(), state: "open".into() }));
        assert_eq!(known_pr(Some(&found(None)), &events), Some(KnownPr { number: 12, url: "https://github.com/o/r/pull/12".into(), state: "merged".into() }));
        assert_eq!(known_pr(None, &events[2..]), None);
        assert_eq!(known_pr(None, &[event(GitHubActivity::PrMerged, 1, json!({ "number": 1, "url": "" }))]), None);
    }

    #[test]
    fn a_pull_request_swaps_the_github_tag_and_keeps_the_rest() {
        let tags = |t: &[&str]| t.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let open = pr("open", 1);
        assert_eq!(with_pr_tag(&tags(&["labor", "draft"]), &open), tags(&["labor", "review"]));
        assert_eq!(with_pr_tag(&tags(&["review", "labor"]), &open), tags(&["review", "labor"]), "the order stays when nothing changes");
        assert_eq!(with_pr_tag(&tags(&["labor"]), &pr("merged", 1)), tags(&["labor", "merged"]));
        assert_eq!(pr_tag(&PullRequest { draft: true, ..open.clone() }), "draft");
        assert_eq!(pr_tag(&PullRequest { review_decision: Some("changes_requested".into()), ..open.clone() }), "changes-requested");
        assert_eq!(pr_tag(&PullRequest { review_decision: Some("approved".into()), ..open }), "approved");
    }
}
