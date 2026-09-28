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

fn with_state(list: &[Subagent], at: usize, state: AgentState) -> Vec<Subagent> {
    list.iter().enumerate().map(|(i, s)| if i == at { Subagent { state, ..s.clone() } } else { s.clone() }).collect()
}

fn fresh(id: Option<String>, label: String, description: Option<String>, at_ms: u64) -> Subagent {
    Subagent { id, label, description, state: AgentState::Working, started_at_ms: at_ms }
}

fn pushed(list: &[Subagent], item: Subagent) -> Vec<Subagent> {
    let all: Vec<Subagent> = list.iter().cloned().chain(std::iter::once(item)).collect();
    let extra = all.len().saturating_sub(MAX_SUBAGENTS);
    all.into_iter().skip(extra).collect()
}

pub fn apply(list: &[Subagent], event: &SubagentEvent, at_ms: u64) -> Vec<Subagent> {
    match event {
        SubagentEvent::Launch { label, description } => pushed(list, fresh(None, label.clone(), description.clone(), at_ms)),
        SubagentEvent::Start { id, label } => match (position_of(list, id), unassigned_of(list, label)) {
            (Some(_), _) => list.to_vec(),
            (None, Some(at)) => list.iter().enumerate().map(|(i, s)| if i == at { Subagent { id: Some(id.clone()), label: label.clone(), ..s.clone() } } else { s.clone() }).collect(),
            (None, None) => pushed(list, fresh(Some(id.clone()), label.clone(), None, at_ms)),
        },
        SubagentEvent::Stop { id } => position_of(list, id).map_or_else(|| list.to_vec(), |at| with_state(list, at, AgentState::Exited)),
        SubagentEvent::Activity { id, state } => match position_of(list, id) {
            Some(at) if list[at].state != AgentState::Exited => with_state(list, at, *state),
            _ => list.to_vec(),
        },
    }
}

/// What survives a change of the parent's state. A finished turn drops the finished and the never started
/// subagents, and keeps one that still runs in the background. An exited parent keeps none.
pub fn settle(list: &[Subagent], parent: AgentState) -> Vec<Subagent> {
    match parent {
        AgentState::Exited => Vec::new(),
        AgentState::Idle => list.iter().filter(|s| s.id.is_some() && s.state != AgentState::Exited).cloned().collect(),
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
