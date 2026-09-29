use tomo_proto::{AgentPresence, AgentReport, AgentState, Authority};

fn fresh(report: &AgentReport, worktree_id: &str, pid: Option<u32>) -> AgentPresence {
    AgentPresence {
        pane_id: report.pane_id.clone(),
        worktree_id: worktree_id.to_string(),
        kind: report.kind,
        state: report.state.unwrap_or(AgentState::Unknown),
        session_ref: report.session_ref.clone(),
        authority: report.authority,
        updated_at_ms: report.at_ms,
        pid,
        estimated: report.state.is_some() && report.authority == Authority::Heuristic,
        seen: false,
        subagents: Vec::new(),
        sleep: None,
    }
}

/// Whether `report` may set the state. A hook state is never replaced by a weaker source, however old it is:
/// an idle agent is quiet for hours, correctly. Among hook events, the one that fired last wins, whatever
/// order the hook processes arrive in. See docs/agent-states.md.
fn takes_state(cur: &AgentPresence, report: &AgentReport) -> bool {
    match (report.state, cur.authority == Authority::Lifecycle) {
        (None, _) => false,
        (Some(_), true) => report.authority == Authority::Lifecycle && report.at_ms >= cur.updated_at_ms,
        (Some(_), false) => report.authority < cur.authority || (report.authority == cur.authority && report.at_ms >= cur.updated_at_ms),
    }
}

pub fn merge(current: Option<&AgentPresence>, report: &AgentReport, worktree_id: &str, pid: Option<u32>) -> Option<AgentPresence> {
    let Some(cur) = current else {
        return Some(fresh(report, worktree_id, pid));
    };
    let ended = matches!(cur.state, AgentState::Exited | AgentState::Dead);
    if ended && pid.is_some() && cur.pid.is_some() && pid != cur.pid {
        return Some(fresh(report, worktree_id, pid));
    }
    let session_ref = report.session_ref.clone().or_else(|| cur.session_ref.clone());
    let pid = pid.or(cur.pid);
    let accept = takes_state(cur, report);
    let next_state = if accept { report.state.unwrap_or(cur.state) } else { cur.state };
    let changed = accept || session_ref != cur.session_ref || pid != cur.pid || report.kind != cur.kind;
    if !changed {
        return None;
    }
    Some(AgentPresence {
        pane_id: cur.pane_id.clone(),
        worktree_id: cur.worktree_id.clone(),
        kind: if accept { report.kind } else { cur.kind },
        state: next_state,
        session_ref,
        authority: if accept { report.authority } else { cur.authority },
        updated_at_ms: if accept { report.at_ms } else { cur.updated_at_ms },
        pid,
        estimated: if accept { report.authority == Authority::Heuristic } else { cur.estimated },
        seen: cur.seen && next_state == cur.state,
        subagents: cur.subagents.clone(),
        sleep: cur.sleep,
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
    fn a_heuristic_never_replaces_a_hook_state_however_old() {
        let cur = merge(None, &report(Authority::Lifecycle, Some(AgentState::Idle), 1000), "w", Some(1)).unwrap();
        assert!(merge(Some(&cur), &report(Authority::Heuristic, Some(AgentState::Working), 2000), "w", Some(1)).is_none());
        assert!(merge(Some(&cur), &report(Authority::Heuristic, Some(AgentState::Working), 1000 + 24 * 3_600_000), "w", Some(1)).is_none(), "a day later too");
    }

    #[test]
    fn the_fallback_sets_both_states_until_the_first_hook() {
        let first = merge(None, &report(Authority::Heuristic, Some(AgentState::Working), 1), "w", Some(1)).unwrap();
        assert!(first.estimated);
        let quiet = merge(Some(&first), &report(Authority::Heuristic, Some(AgentState::Idle), 2), "w", Some(1)).unwrap();
        assert_eq!((quiet.state, quiet.estimated), (AgentState::Idle, true));
        let hooked = merge(Some(&quiet), &report(Authority::Lifecycle, Some(AgentState::Working), 3), "w", Some(1)).unwrap();
        assert_eq!((hooked.state, hooked.estimated, hooked.authority), (AgentState::Working, false, Authority::Lifecycle));
        assert!(merge(Some(&hooked), &report(Authority::Heuristic, Some(AgentState::Idle), 4), "w", Some(1)).is_none(), "the first hook ends the fallback");
    }

    #[test]
    fn a_state_change_clears_seen_and_a_new_process_starts_fresh() {
        let done = AgentPresence { seen: true, ..merge(None, &report(Authority::Lifecycle, Some(AgentState::Done), 1), "w", Some(1)).unwrap() };
        let working = merge(Some(&done), &report(Authority::Lifecycle, Some(AgentState::Working), 2), "w", Some(1)).unwrap();
        assert!(!working.seen);
        let dead = merge(Some(&working), &report(Authority::Lifecycle, Some(AgentState::Dead), 3), "w", Some(1)).unwrap();
        let next = merge(Some(&dead), &report(Authority::Heuristic, Some(AgentState::Working), 4), "w", Some(2)).unwrap();
        assert_eq!((next.state, next.authority, next.pid), (AgentState::Working, Authority::Heuristic, Some(2)), "a new agent in the pane may use the fallback");
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
        assert!(
            merge(Some(&waiting), &rep("p", Authority::Heuristic, Some(AgentState::Working), 11_000), "w", Some(7)).is_none(),
            "heuristic must not beat fresh lifecycle"
        );
        assert!(merge(Some(&waiting), &rep("p", Authority::Lifecycle, Some(AgentState::Idle), 9_000), "w", Some(7)).is_none(), "older lifecycle is ignored");
        assert!(
            merge(Some(&waiting), &rep("p", Authority::Report, Some(AgentState::Idle), 12_000), "w", Some(7)).is_none(),
            "explicit report is weaker than lifecycle"
        );
        let exited = merge(Some(&waiting), &rep("p", Authority::Lifecycle, Some(AgentState::Exited), 10_001), "w", None).unwrap();
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
