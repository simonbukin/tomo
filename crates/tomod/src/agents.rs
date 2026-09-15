use tomo_proto::{AgentPresence, AgentReport, AgentState};

/// A weaker source may replace a stronger one only after this much silence.
pub const STALE_MS: u64 = 15 * 60 * 1000;

pub fn merge(current: Option<&AgentPresence>, report: &AgentReport, worktree_id: &str, pid: Option<u32>) -> Option<AgentPresence> {
    let Some(cur) = current else {
        return Some(AgentPresence {
            pane_id: report.pane_id.clone(),
            worktree_id: worktree_id.to_string(),
            kind: report.kind,
            state: report.state.unwrap_or(AgentState::Unknown),
            session_ref: report.session_ref.clone(),
            authority: report.authority,
            updated_at_ms: report.at_ms,
            pid,
        });
    };
    let session_ref = report.session_ref.clone().or_else(|| cur.session_ref.clone());
    let pid = pid.or(cur.pid);
    let stronger = report.authority < cur.authority;
    let same_and_newer = report.authority == cur.authority && report.at_ms >= cur.updated_at_ms;
    let stale = cur.updated_at_ms + STALE_MS < report.at_ms;
    let accept_state = report.state.is_some() && (stronger || same_and_newer || stale);
    let changed = accept_state || session_ref != cur.session_ref || pid != cur.pid || report.kind != cur.kind;
    if !changed {
        return None;
    }
    Some(AgentPresence {
        pane_id: cur.pane_id.clone(),
        worktree_id: cur.worktree_id.clone(),
        kind: if stronger || same_and_newer { report.kind } else { cur.kind },
        state: if accept_state { report.state.unwrap() } else { cur.state },
        session_ref,
        authority: if accept_state { report.authority } else { cur.authority },
        updated_at_ms: if accept_state { report.at_ms } else { cur.updated_at_ms },
        pid,
    })
}

pub fn shell_quote(arg: &str) -> String {
    let safe = !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if safe {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

pub fn shell_line(argv: &[String]) -> String {
    argv.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tomo_proto::{AgentKind, Authority};

    fn report(auth: Authority, state: Option<AgentState>, at: u64) -> AgentReport {
        AgentReport { pane_id: "p".into(), kind: AgentKind::Claude, state, session_ref: None, authority: auth, at_ms: at }
    }

    #[test]
    fn heuristic_does_not_overwrite_fresh_lifecycle_state() {
        let cur = merge(None, &report(Authority::Lifecycle, Some(AgentState::Waiting), 1000), "w", Some(1)).unwrap();
        assert!(merge(Some(&cur), &report(Authority::Heuristic, Some(AgentState::Working), 2000), "w", Some(1)).is_none());
        let after = merge(Some(&cur), &report(Authority::Heuristic, Some(AgentState::Working), 1000 + STALE_MS + 1), "w", Some(1)).unwrap();
        assert_eq!(after.state, AgentState::Working);
    }

    #[test]
    fn stale_lifecycle_message_cannot_rewind() {
        let cur = merge(None, &report(Authority::Lifecycle, Some(AgentState::Idle), 5000), "w", None).unwrap();
        assert!(merge(Some(&cur), &report(Authority::Lifecycle, Some(AgentState::Working), 4000), "w", None).is_none());
        let newer = merge(Some(&cur), &report(Authority::Lifecycle, Some(AgentState::Working), 5000), "w", None).unwrap();
        assert_eq!(newer.state, AgentState::Working);
    }

    #[test]
    fn session_ref_updates_without_state() {
        let cur = merge(None, &report(Authority::Lifecycle, Some(AgentState::Idle), 1), "w", None).unwrap();
        let mut r = report(Authority::Heuristic, None, 2);
        r.session_ref = Some("abc".into());
        let after = merge(Some(&cur), &r, "w", Some(9)).unwrap();
        assert_eq!(after.session_ref.as_deref(), Some("abc"));
        assert_eq!(after.state, AgentState::Idle);
        assert_eq!(after.pid, Some(9));
    }

    fn rep(pane: &str, auth: Authority, state: Option<AgentState>, at: u64) -> AgentReport {
        AgentReport { pane_id: pane.into(), kind: AgentKind::Claude, state, session_ref: None, authority: auth, at_ms: at }
    }

    #[test]
    fn torture_authority_battery() {
        let waiting = merge(None, &rep("p", Authority::Lifecycle, Some(AgentState::Waiting), 10_000), "w", Some(7)).unwrap();
        assert!(merge(Some(&waiting), &rep("p", Authority::Heuristic, Some(AgentState::Working), 11_000), "w", Some(7)).is_none(), "heuristic must not beat fresh lifecycle");
        assert!(merge(Some(&waiting), &rep("p", Authority::Lifecycle, Some(AgentState::Idle), 9_000), "w", Some(7)).is_none(), "older lifecycle is ignored");
        assert!(merge(Some(&waiting), &rep("p", Authority::Report, Some(AgentState::Idle), 12_000), "w", Some(7)).is_none(), "explicit report is weaker than lifecycle");
        let stale = merge(Some(&waiting), &rep("p", Authority::Heuristic, Some(AgentState::Working), 10_000 + STALE_MS + 1), "w", Some(7)).unwrap();
        assert_eq!((stale.state, stale.authority), (AgentState::Working, Authority::Heuristic), "silent lifecycle yields to heuristic");
        let back = merge(Some(&stale), &rep("p", Authority::Lifecycle, Some(AgentState::Idle), 10_000 + STALE_MS + 2), "w", Some(7)).unwrap();
        assert_eq!(back.state, AgentState::Idle, "lifecycle regains authority immediately");
        let exited = merge(Some(&back), &rep("p", Authority::Lifecycle, Some(AgentState::Exited), 10_000 + STALE_MS + 3), "w", None).unwrap();
        assert_eq!(exited.state, AgentState::Exited);
        assert_eq!(exited.pid, Some(7), "pid is kept until a new one is seen");
    }

    #[test]
    fn torture_same_kind_agents_are_independent() {
        let a = merge(None, &rep("a", Authority::Lifecycle, Some(AgentState::Working), 1), "w", Some(1)).unwrap();
        let b = merge(None, &rep("b", Authority::Lifecycle, Some(AgentState::Idle), 1), "w", Some(2)).unwrap();
        let a2 = merge(Some(&a), &rep("a", Authority::Lifecycle, Some(AgentState::Waiting), 2), "w", Some(1)).unwrap();
        assert_eq!(a2.pane_id, "a");
        assert_eq!(b.state, AgentState::Idle);
        assert!(merge(Some(&b), &rep("b", Authority::Heuristic, None, 3), "w", Some(2)).is_none(), "presence-only report with nothing new is a no-op");
    }

    #[test]
    fn torture_resumed_process_rebuilds_presence() {
        let old = merge(None, &rep("p", Authority::Lifecycle, Some(AgentState::Exited), 5), "w", Some(10)).unwrap();
        let mut fresh = rep("p", Authority::Lifecycle, Some(AgentState::Idle), 6);
        fresh.session_ref = Some("sess".into());
        let next = merge(Some(&old), &fresh, "w", Some(11)).unwrap();
        assert_eq!((next.state, next.pid, next.session_ref.as_deref()), (AgentState::Idle, Some(11), Some("sess")));
    }

    #[test]
    fn shell_line_quotes_only_what_the_shell_would_split() {
        let argv: Vec<String> = ["/Applications/My Tools/claude", "--settings", "/d/claude-hooks.json", "--resume", "it's"].map(String::from).to_vec();
        assert_eq!(shell_line(&argv), "'/Applications/My Tools/claude' --settings /d/claude-hooks.json --resume 'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a=b:c@d%e+f,g"), "a=b:c@d%e+f,g");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
    }
}
