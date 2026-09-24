//! Agentation in the daemon: `annotations_send` types the feedback of a browser page into a live agent pane,
//! records `annotations_sent`, and runs the `annotation.sent` hooks. It keeps no state.
//! The overlay, the notes, and the toolbar live in the GUI and the Tauri host.

use crate::activity;
use crate::daemon::{err, ok, Daemon, Inner};
use crate::events;
use serde_json::Value;
use std::sync::Arc;
use tomo_proto::*;

/// The hook events this addon fires. The composition root registers them through `Seams::hook_events`.
pub const HOOK_EVENTS: &[&str] = &["annotation.sent"];

pub fn send(daemon: &Arc<Daemon>, pane_id: &str, bundle: &EvidenceBundle) -> Result<Value, RpcError> {
    let event = {
        let mut inner = daemon.lock();
        let worktree_id = inner.panes.get(pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?.row.worktree_id.clone();
        let text = evidence_text(&worktree_label(&inner, &bundle.worktree_id, &worktree_id), &runtime_label(&inner, &worktree_id, bundle), bundle);
        let (agent, hook_pane) = Daemon::paste_to_agent(&inner, pane_id, &text)?;
        let event = ActivityEvent {
            pane_id: Some(pane_id.to_string()),
            agent_kind: Some(agent.kind),
            detail: bundle.url.clone(),
            payload: serde_json::to_value(bundle).unwrap_or(Value::Null),
            ..activity::event(AgentationActivity::AnnotationsSent, Some(&worktree_id), evidence_title(bundle, agent.kind.label()))
        };
        Daemon::record(&mut inner, event.clone());
        let hook = HookEvent {
            pane: Some(hook_pane),
            agent: Some(HookAgent { kind: agent.kind, state: agent.state, session_ref: agent.session_ref }),
            ..events::envelope(&inner, "annotation.sent", Some(&worktree_id))
        };
        inner.hook_queue.push(hook);
        event
    };
    daemon.flush_hooks();
    ok(event)
}

/// `name (branch)` of the worktree that the bundle names, else of the agent pane.
fn worktree_label(inner: &Inner, bundle_worktree: &str, pane_worktree: &str) -> String {
    let (name, branch) = inner
        .worktrees
        .get(bundle_worktree)
        .or_else(|| inner.worktrees.get(pane_worktree))
        .map(|w| (Daemon::worktree_view(inner, w).name, w.branch.clone().unwrap_or_else(|| "detached".to_string())))
        .unwrap_or_default();
    format!("{name} ({branch})")
}

/// The source label of a running pane in the worktree that started from `action_id`, else the page url.
fn runtime_label(inner: &Inner, worktree_id: &str, bundle: &EvidenceBundle) -> String {
    bundle
        .action_id
        .as_deref()
        .and_then(|a| {
            inner
                .panes
                .values()
                .filter(|p| p.row.worktree_id == worktree_id)
                .find_map(|p| p.source.as_ref().filter(|s| PaneSource::action_id(Some(s)).as_deref() == Some(a)))
        })
        .map(|s| s.label.clone())
        .or_else(|| bundle.url.clone())
        .unwrap_or_else(|| "-".to_string())
}

/// The plain-text form of an evidence bundle, as typed into an agent's terminal.
fn evidence_text(worktree: &str, runtime: &str, bundle: &EvidenceBundle) -> String {
    let body = match bundle.markdown.as_deref().map(str::trim) {
        Some(markdown) if !markdown.is_empty() => markdown.to_string(),
        _ => bundle
            .annotations
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let selector = a.selector.as_deref().unwrap_or("-");
                let element = a.element_text.as_deref().unwrap_or("").replace('\n', " ");
                format!("{}. [{selector}] \"{element}\" — {}", i + 1, a.text.trim())
            })
            .collect::<Vec<_>>()
            .join("\n"),
    };
    format!("Browser feedback from Tomo\nworktree: {worktree}\nruntime: {runtime}\n\n{body}\n\n{}", bundle.instruction.trim())
}

fn evidence_title(bundle: &EvidenceBundle, agent: &str) -> String {
    match bundle.note_count {
        Some(1) => format!("Sent 1 note → {agent}"),
        Some(n) => format!("Sent {n} notes → {agent}"),
        None => format!("Sent {} annotations → {agent}", bundle.annotations.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_text_lists_annotations_in_order() {
        let bundle = EvidenceBundle {
            source: "browser annotation".into(),
            worktree_id: "w".into(),
            url: Some("http://localhost:1420/".into()),
            action_id: None,
            annotations: vec![
                Annotation {
                    text: "wrong color".into(),
                    url: "http://localhost:1420/".into(),
                    selector: Some("#save".into()),
                    element_text: Some("Save".into()),
                    rect: None,
                },
                Annotation {
                    text: "cut off".into(),
                    url: "http://localhost:1420/".into(),
                    selector: None,
                    element_text: None,
                    rect: Some([1.0, 2.0, 3.0, 4.0]),
                },
            ],
            instruction: "Review and address these annotations.".into(),
            markdown: None,
            note_count: None,
        };
        let text = evidence_text("labor (feat/x)", "http://localhost:1420/", &bundle);
        assert_eq!(
            text,
            "Browser feedback from Tomo\nworktree: labor (feat/x)\nruntime: http://localhost:1420/\n\n1. [#save] \"Save\" — wrong color\n2. [-] \"\" — cut off\n\nReview and address these annotations."
        );
        assert_eq!(evidence_title(&bundle, "Claude"), "Sent 2 annotations → Claude");
    }

    #[test]
    fn evidence_text_uses_the_markdown_body() {
        let bundle = EvidenceBundle {
            source: "browser feedback".into(),
            worktree_id: "w".into(),
            url: Some("http://localhost:1420/".into()),
            action_id: None,
            annotations: vec![],
            instruction: "Review and address this feedback.".into(),
            markdown: Some("## Tomo (http://localhost:1420/)\n\n1. button `main > button`\n   wrong color\n".into()),
            note_count: Some(3),
        };
        let text = evidence_text("labor (feat/x)", "http://localhost:1420/", &bundle);
        assert_eq!(
            text,
            "Browser feedback from Tomo\nworktree: labor (feat/x)\nruntime: http://localhost:1420/\n\n## Tomo (http://localhost:1420/)\n\n1. button `main > button`\n   wrong color\n\nReview and address this feedback."
        );
        assert_eq!(evidence_title(&bundle, "Claude"), "Sent 3 notes → Claude");
        assert_eq!(evidence_title(&EvidenceBundle { note_count: Some(1), ..bundle }, "Codex"), "Sent 1 note → Codex");
    }
}
