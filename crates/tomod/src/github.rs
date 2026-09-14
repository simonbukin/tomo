use serde_json::Value;
use std::path::Path;
use tomo_proto::{now_ms, PrStatusResult, PullRequest};

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

/// Asks the GitHub CLI for the pull request of the branch checked out in `worktree`.
pub async fn pr_status(worktree: &Path) -> PrStatusResult {
    let out = tokio::process::Command::new("gh")
        .args(["pr", "view", "--json", "number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup"])
        .current_dir(worktree)
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .output()
        .await;
    match out {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PrStatusResult { available: false, reason: Some("gh is not installed".into()), pr: None },
        Err(e) => PrStatusResult { available: false, reason: Some(e.to_string()), pr: None },
        Ok(o) if o.status.success() => {
            let v: Value = serde_json::from_slice(&o.stdout).unwrap_or(Value::Null);
            PrStatusResult { available: true, reason: None, pr: parse_pr(&v) }
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if err.contains("no pull requests found") {
                PrStatusResult { available: true, reason: None, pr: None }
            } else {
                PrStatusResult { available: false, reason: Some(err.lines().next().unwrap_or("gh failed").to_string()), pr: None }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
