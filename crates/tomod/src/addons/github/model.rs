use crate::activity;
use crate::trail::BranchTouch;
use serde_json::{json, Value};
use std::process::Output;
use tomo_proto::{now_ms, utc_ms, ActivityEvent, ActivityKind, GitHubActivity, PrStatusResult, PullRequest};

/// How long a fetched pull request answers `pr_status` without a new `gh` run.
pub const FRESH_MS: u64 = 60_000;

/// The `--json` fields of both `gh pr view` and `gh pr list`.
pub const PR_FIELDS: &str = "number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup,headRefName,updatedAt,isCrossRepository";

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
        head: v.get("headRefName").and_then(Value::as_str).unwrap_or("").to_string(),
        updated_at_ms: v.get("updatedAt").and_then(Value::as_str).and_then(utc_ms).unwrap_or(0),
        touched_ms: 0,
    })
}

fn unavailable(reason: impl Into<String>) -> PrStatusResult {
    PrStatusResult { available: false, reason: Some(reason.into()), pr: None, prs: vec![] }
}

/// The newest pull request in the answer of `gh pr list --head <branch>`. None for a failure or no pull request.
/// `--head` matches the branch name in a fork too, so a branch such as `main` gives the pull requests of forks. Only
/// one from this repository counts.
pub fn listed(out: std::io::Result<Output>) -> Option<PullRequest> {
    let out = out.ok().filter(|o| o.status.success())?;
    let list = serde_json::from_slice::<Value>(&out.stdout).ok()?;
    list.as_array()?.iter().find(|v| v.get("isCrossRepository").and_then(Value::as_bool) != Some(true)).and_then(parse_pr)
}

/// The answer for the branch now, with the pull requests of the earlier branches. Each one gets the time that this
/// worktree last touched its head, and the list goes newest first by that time or by the last change on GitHub.
pub fn with_history(current: PrStatusResult, earlier: Vec<PullRequest>, trail: &[BranchTouch]) -> PrStatusResult {
    let touched = |pr: PullRequest| PullRequest { touched_ms: trail.iter().find(|t| t.branch == pr.head).map_or(0, |t| t.touched_ms), ..pr };
    let pr = current.pr.map(touched);
    let mut prs = pr.iter().cloned().chain(earlier.into_iter().map(touched)).fold(Vec::<PullRequest>::new(), |mut seen, p| {
        if !seen.iter().any(|s| s.number == p.number) {
            seen.push(p);
        }
        seen
    });
    prs.sort_by_key(|p| std::cmp::Reverse(p.touched_ms.max(p.updated_at_ms)));
    PrStatusResult { pr, prs, ..current }
}

/// The `pr_status` answer for the outcome of `gh pr view`.
pub fn answer(out: std::io::Result<Output>) -> PrStatusResult {
    match out {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => unavailable("gh is not installed"),
        Err(e) => unavailable(e.to_string()),
        Ok(o) if o.status.success() => {
            PrStatusResult { available: true, reason: None, pr: parse_pr(&serde_json::from_slice(&o.stdout).unwrap_or(Value::Null)), prs: vec![] }
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if err.contains("no pull requests found") {
                PrStatusResult { available: true, reason: None, pr: None, prs: vec![] }
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
    /// A pull request differs, so `pr_changed` fires. A new fetch of the same pull request differs by `fetched_at_ms`.
    pub changed: bool,
    /// The pull request is merged now and was not merged before, so `pr_merged` is recorded.
    pub merged: Option<&'a PullRequest>,
}

pub fn update<'a>(before: Option<&PrStatusResult>, after: &'a PrStatusResult) -> Update<'a> {
    let was_merged = before.and_then(|b| b.pr.as_ref()).is_some_and(|pr| pr.state == "merged");
    Update { changed: before.map(|b| (&b.pr, &b.prs)) != Some((&after.pr, &after.prs)), merged: after.pr.as_ref().filter(|pr| pr.state == "merged" && !was_merged) }
}

pub fn merged_event(worktree_id: &str, pr: &PullRequest) -> ActivityEvent {
    ActivityEvent {
        detail: Some(pr.title.clone()),
        payload: json!({ "number": pr.number, "url": pr.url }),
        ..activity::event(GitHubActivity::PrMerged, Some(worktree_id), format!("PR #{} merged", pr.number))
    }
}

/// The tags that this addon once wrote for the state of a pull request. `migrate` removes them one time.
pub const OLD_PR_TAGS: [&str; 6] = ["draft", "review", "changes-requested", "approved", "merged", "closed"];

pub fn without_old_pr_tags(tags: &[String]) -> Vec<String> {
    tags.iter().filter(|t| !OLD_PR_TAGS.contains(&t.as_str())).cloned().collect()
}

/// The `pull_request` field of a `github.pr_merged` hook event.
pub fn hook_fields(pr: &PullRequest) -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([("pull_request".to_string(), json!({ "number": pr.number, "title": pr.title, "url": pr.url }))])
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
            head: String::new(),
            updated_at_ms: 0,
            touched_ms: 0,
        }
    }

    fn found(pr: Option<PullRequest>) -> PrStatusResult {
        PrStatusResult { available: true, reason: None, pr, prs: vec![] }
    }

    fn on(number: u64, head: &str, updated_at_ms: u64) -> PullRequest {
        PullRequest { number, head: head.into(), updated_at_ms, ..pr("open", 1) }
    }

    fn touch(branch: &str, touched_ms: u64) -> BranchTouch {
        BranchTouch { branch: branch.into(), touched_ms, subjects: vec![] }
    }

    #[test]
    fn reads_the_head_and_the_update_time() {
        let v = serde_json::json!({ "number": 4, "headRefName": "you/eng-31-retry", "updatedAt": "2026-10-13T14:05:22Z" });
        let pr = parse_pr(&v).unwrap();
        assert_eq!((pr.head.as_str(), pr.updated_at_ms, pr.touched_ms), ("you/eng-31-retry", 1_791_900_322_000, 0));
    }

    #[test]
    fn a_list_answer_gives_its_first_pull_request() {
        assert_eq!(listed(gh(0, r#"[{"number":9,"state":"MERGED"},{"number":2}]"#, "")).map(|p| p.number), Some(9));
        assert_eq!(listed(gh(0, r#"[{"number":9,"isCrossRepository":true},{"number":2,"isCrossRepository":false}]"#, "")).map(|p| p.number), Some(2));
        assert_eq!(listed(gh(0, r#"[{"number":9,"isCrossRepository":true}]"#, "")), None);
        assert_eq!(listed(gh(0, "[]", "")), None);
        assert_eq!(listed(gh(1, "", "boom")), None);
        assert_eq!(listed(Err(std::io::Error::other("no gh"))), None);
    }

    #[test]
    fn history_puts_every_pull_request_once_the_most_recently_touched_first() {
        let trail = [touch("now", 300), touch("before", 200), touch("long-ago", 100)];
        let current = found(Some(on(1, "now", 0)));
        let result = with_history(current, vec![on(2, "long-ago", 250), on(1, "now", 0), on(3, "before", 0)], &trail);
        assert_eq!(result.prs.iter().map(|p| (p.number, p.touched_ms)).collect::<Vec<_>>(), vec![(1, 300), (2, 100), (3, 200)]);
        assert_eq!(result.pr.map(|p| p.touched_ms), Some(300));
        assert!(result.available);
        let none = with_history(found(None), vec![on(5, "before", 0)], &trail);
        assert_eq!((none.pr, none.prs.len()), (None, 1));
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
    fn the_old_pull_request_tags_go_and_the_rest_stay_in_order() {
        let tags = |t: &[&str]| t.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(without_old_pr_tags(&tags(&["sync", "review", "q4", "merged"])), tags(&["sync", "q4"]));
        assert_eq!(without_old_pr_tags(&tags(&["sync"])), tags(&["sync"]));
    }
}
