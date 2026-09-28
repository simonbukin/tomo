//! The live subagents of one agent pane. A provider maps its hook payloads onto
//! `SubagentEvent` in its `hook_outcome`; this module folds the events into the
//! list on `AgentPresence`, with no knowledge of any one provider.

use tomo_proto::{AgentState, Subagent};

/// ponytail: a fixed cap, so a runaway fan-out cannot grow one presence without bound.
pub const MAX_SUBAGENTS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentEvent {
    /// The parent asked for a subagent. The provider has not given it an id yet.
    Launch { label: String, description: Option<String> },
    Start { id: String, label: String },
    Stop { id: String },
    /// A hook fired inside the subagent.
    Activity { id: String, state: AgentState },
}

fn unassigned_of(list: &[Subagent], label: &str) -> Option<usize> {
    list.iter().position(|s| s.id.is_none() && s.label == label).or_else(|| list.iter().position(|s| s.id.is_none()))
}

fn position_of(list: &[Subagent], id: &str) -> Option<usize> {
    list.iter().position(|s| s.id.as_deref() == Some(id))
}

fn with_state(list: &[Subagent], at: usize, state: AgentState, at_ms: u64) -> Vec<Subagent> {
    list.iter().enumerate().map(|(i, s)| if i == at { Subagent { state, updated_at_ms: at_ms, ..s.clone() } } else { s.clone() }).collect()
}

/// A subagent with no event for this long, while its parent does not work, lost its stop event.
pub const SILENT_MS: u64 = 30 * 60 * 1000;

fn fresh(id: Option<String>, label: String, description: Option<String>, at_ms: u64) -> Subagent {
    Subagent { id, label, description, state: AgentState::Working, started_at_ms: at_ms, updated_at_ms: at_ms }
}

/// Adds `item`. Above the cap, the oldest finished subagents go first, and only then the oldest running ones.
fn pushed(list: &[Subagent], item: Subagent) -> Vec<Subagent> {
    let all: Vec<Subagent> = list.iter().cloned().chain(std::iter::once(item)).collect();
    let extra = all.len().saturating_sub(MAX_SUBAGENTS);
    let finished: Vec<usize> = all.iter().enumerate().filter(|(_, s)| s.state == AgentState::Exited).map(|(i, _)| i).take(extra).collect();
    let running: Vec<usize> = all.iter().enumerate().filter(|(i, _)| !finished.contains(i)).map(|(i, _)| i).take(extra - finished.len()).collect();
    all.into_iter().enumerate().filter(|(i, _)| !finished.contains(i) && !running.contains(i)).map(|(_, s)| s).collect()
}

/// Drops a running subagent that sent nothing for `SILENT_MS` while its parent does not work.
pub fn expire(list: &[Subagent], parent: AgentState, now: u64) -> Vec<Subagent> {
    if parent == AgentState::Working {
        return list.to_vec();
    }
    list.iter().filter(|s| s.state == AgentState::Exited || now.saturating_sub(s.updated_at_ms.max(s.started_at_ms)) < SILENT_MS).cloned().collect()
}

pub fn apply(list: &[Subagent], event: &SubagentEvent, at_ms: u64) -> Vec<Subagent> {
    match event {
        SubagentEvent::Launch { label, description } => pushed(list, fresh(None, label.clone(), description.clone(), at_ms)),
        SubagentEvent::Start { id, label } => match (position_of(list, id), unassigned_of(list, label)) {
            (Some(_), _) => list.to_vec(),
            (None, Some(at)) => list.iter().enumerate().map(|(i, s)| if i == at { Subagent { id: Some(id.clone()), label: label.clone(), updated_at_ms: at_ms, ..s.clone() } } else { s.clone() }).collect(),
            (None, None) => pushed(list, fresh(Some(id.clone()), label.clone(), None, at_ms)),
        },
        SubagentEvent::Stop { id } => position_of(list, id).map_or_else(|| list.to_vec(), |at| with_state(list, at, AgentState::Exited, at_ms)),
        SubagentEvent::Activity { id, state } => match position_of(list, id) {
            Some(at) if list[at].state != AgentState::Exited => with_state(list, at, *state, at_ms),
            _ => list.to_vec(),
        },
    }
}

/// What survives a change of the parent's state. A finished turn drops the finished and the never started
/// subagents, and keeps one that still runs in the background. An exited parent keeps none.
pub fn settle(list: &[Subagent], parent: AgentState) -> Vec<Subagent> {
    match parent {
        AgentState::Exited | AgentState::Dead => Vec::new(),
        AgentState::Idle | AgentState::Done => list.iter().filter(|s| s.id.is_some() && s.state != AgentState::Exited).cloned().collect(),
        _ => list.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(label: &str, description: &str) -> SubagentEvent {
        SubagentEvent::Launch { label: label.into(), description: Some(description.into()) }
    }

    fn start(id: &str, label: &str) -> SubagentEvent {
        SubagentEvent::Start { id: id.into(), label: label.into() }
    }

    fn run(events: &[SubagentEvent]) -> Vec<Subagent> {
        events.iter().enumerate().fold(Vec::new(), |list, (i, e)| apply(&list, e, i as u64))
    }

    fn stop(id: &str) -> SubagentEvent {
        SubagentEvent::Stop { id: id.into() }
    }

    #[test]
    fn a_silent_subagent_under_a_parent_that_does_not_work_is_dropped() {
        let list = run(&[start("a", "Explore"), start("b", "Plan")]);
        let later = SILENT_MS + 10;
        assert_eq!(expire(&list, AgentState::Working, later).len(), 2, "a working parent keeps them");
        assert!(expire(&list, AgentState::Done, later).is_empty(), "a lost stop event ends with the parent's turn");
        let touched = apply(&list, &SubagentEvent::Activity { id: "a".into(), state: AgentState::Working }, later - 5);
        let kept: Vec<Option<String>> = expire(&touched, AgentState::Idle, later).into_iter().map(|s| s.id).collect();
        assert_eq!(kept, [Some("a".to_string())], "an event resets the clock");
    }

    #[test]
    fn above_the_cap_a_finished_subagent_goes_before_a_running_one() {
        let events: Vec<SubagentEvent> = (0..MAX_SUBAGENTS).map(|i| start(&format!("s{i}"), "Explore")).chain([stop("s5"), start("new", "Explore")]).collect();
        let list = run(&events);
        assert_eq!(list.len(), MAX_SUBAGENTS);
        assert!(list.iter().all(|s| s.id.as_deref() != Some("s5")), "the finished one went");
        assert!(list.iter().any(|s| s.id.as_deref() == Some("s0")), "the oldest running one stayed");
    }

    #[test]
    fn a_start_takes_the_description_of_the_launch_with_the_same_label() {
        let list = run(&[launch("Explore", "find the hook"), launch("Plan", "plan it"), start("b", "Plan"), start("a", "Explore")]);
        let pairs: Vec<(Option<&str>, Option<&str>)> = list.iter().map(|s| (s.id.as_deref(), s.description.as_deref())).collect();
        assert_eq!(pairs, [(Some("a"), Some("find the hook")), (Some("b"), Some("plan it"))]);
        assert!(list.iter().all(|s| s.state == AgentState::Working));
    }

    #[test]
    fn a_start_without_a_launch_still_shows() {
        let list = run(&[start("a", "Explore")]);
        assert_eq!((list[0].id.as_deref(), list[0].description.as_deref(), list[0].label.as_str()), (Some("a"), None, "Explore"));
        assert_eq!(run(&[start("a", "Explore"), start("a", "Explore")]).len(), 1, "a repeated start is one subagent");
    }

    #[test]
    fn activity_inside_a_subagent_sets_its_state_until_it_stops() {
        let list = run(&[start("a", "Explore"), SubagentEvent::Activity { id: "a".into(), state: AgentState::Waiting }]);
        assert_eq!(list[0].state, AgentState::Waiting);
        let done = run(&[start("a", "Explore"), SubagentEvent::Stop { id: "a".into() }, SubagentEvent::Activity { id: "a".into(), state: AgentState::Working }]);
        assert_eq!(done[0].state, AgentState::Exited, "a late tool event cannot wake a finished subagent");
        assert!(run(&[SubagentEvent::Stop { id: "x".into() }]).is_empty(), "a stop for an unknown id is ignored");
    }

    #[test]
    fn the_parent_state_decides_what_stays() {
        let list = run(&[start("a", "Explore"), start("b", "Plan"), SubagentEvent::Stop { id: "b".into() }, launch("Explore", "denied")]);
        assert_eq!(settle(&list, AgentState::Working), list);
        let idle = settle(&list, AgentState::Idle);
        assert_eq!(idle.iter().map(|s| s.id.as_deref()).collect::<Vec<_>>(), [Some("a")], "a background subagent outlives the turn");
        assert!(settle(&list, AgentState::Exited).is_empty());
    }

    #[test]
    fn the_list_keeps_the_newest_at_the_cap() {
        let events: Vec<SubagentEvent> = (0..MAX_SUBAGENTS + 3).map(|i| start(&i.to_string(), "Explore")).collect();
        let list = run(&events);
        assert_eq!(list.len(), MAX_SUBAGENTS);
        assert_eq!(list[0].id.as_deref(), Some("3"));
    }
}
